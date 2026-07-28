import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { FileState, type GoogleGenAI } from '@google/genai';
import { db } from '@/db/client';
import { rawClips, segments } from '@/db/schema';
import { downloadClipToTempFile } from '@/lib/storage';
import { getEnvWithDefault } from '@/lib/env';
import { getGeminiClient } from '@/lib/gemini/client';
import { describeCause } from '@/lib/pipeline/errors';
import { withTransientRetry, type TransientRetryOptions } from '@/lib/pipeline/retry';

// Overridable because model availability is genuinely volatile per account:
// gemini-2.5-flash was retired for new API accounts mid-build, Pro models are
// quota-blocked on the free tier, and the free tier's 20-requests-per-day cap
// is *per model*, so switching models is a normal operational move rather than
// a code change. Default is the model verified working against the live API.
const TAGGING_MODEL = getEnvWithDefault('GEMINI_TAGGING_MODEL', 'gemini-3.6-flash');

// How long to wait for Gemini to finish processing an uploaded video before
// giving up: 30 polls x 2s = up to ~60s.
const FILE_POLL_ATTEMPTS = 30;
const FILE_POLL_INTERVAL_MS = 2000;

/**
 * Gemini's "this model is currently experiencing high demand" 503 dropped three
 * of six clips on the first live run. Three tries with ~0.5-1s then ~1-2s of
 * backoff rides out a demand spike while costing at most ~3s per clip, so a
 * genuine outage still fails the job in seconds rather than minutes.
 */
const TAGGING_RETRY: TransientRetryOptions = {
  attempts: 3,
  baseDelayMs: 1000,
  label: 'Gemini tagging call',
};

const TaggedSegmentSchema = z
  .object({
    startSeconds: z.number().min(0),
    endSeconds: z.number().min(0),
    contentTag: z.string(),
    qualityTag: z.string(),
  })
  // A zero- or negative-duration segment is not a usable cut, so treat it
  // as model drift rather than persisting an unrenderable row.
  .refine((s) => s.endSeconds > s.startSeconds, {
    message: 'endSeconds must be greater than startSeconds',
  });

/**
 * Accepts either the requested `{segments: [...]}` wrapper or a bare `[...]`
 * array of segments.
 *
 * The wrapper is what the prompt asks for and what the model returns for short
 * clips, but on a real 30s+ clip it returned the bare array instead — dropping
 * the single most useful clip in the job over a shape the caller does not care
 * about. Both forms carry identical information, so normalising here is
 * strictly better than failing; every element is still validated the same way.
 */
const TaggingResponseSchema = z
  .union([
    z.object({ segments: z.array(TaggedSegmentSchema).min(1) }),
    z.array(TaggedSegmentSchema).min(1),
  ])
  .transform((value) => (Array.isArray(value) ? { segments: value } : value));

const TAGGING_PROMPT = `Analyze this raw video clip for a short-form UGC ad edit.
Always include one segment spanning the entire clip (start 0 to the clip's full duration),
tagged with contentTag "whole-clip". If the clip is long enough to contain additional
distinct good moments, also include those as separate segments with their own start/end
times in seconds. Tag each segment's contentTag as one of: "whole-clip", "b-roll",
"try-on", "other". Tag qualityTag as one of: "low", "medium", "high" based on how
engaging/usable the moment is (steady footage, clear subject, good lighting).
Respond with JSON only, matching this shape:
{"segments": [{"startSeconds": number, "endSeconds": number, "contentTag": string, "qualityTag": string}]}`;

async function waitUntilActive(client: GoogleGenAI, fileName: string): Promise<void> {
  for (let attempt = 0; attempt < FILE_POLL_ATTEMPTS; attempt++) {
    const file = await client.files.get({ name: fileName });
    if (file.state === FileState.ACTIVE) return;
    if (file.state === FileState.FAILED) throw new Error('Gemini file processing failed');
    await new Promise((resolve) => setTimeout(resolve, FILE_POLL_INTERVAL_MS));
  }
  throw new Error('Gemini file did not become ACTIVE in time');
}

export async function tagClip(
  rawClipId: string
): Promise<{ success: true; segmentCount: number } | { success: false; error: string }> {
  try {
    const [clip] = await db.select().from(rawClips).where(eq(rawClips.id, rawClipId));
    if (!clip) return { success: false, error: `Raw clip ${rawClipId} not found` };

    // Streamed to disk rather than buffered: a raw phone clip is routinely
    // 100-200MB and the old path held it three times over in memory, which is
    // how a multi-clip job could OOM the worker and strand itself.
    const localClip = await downloadClipToTempFile(clip.storageKey);
    const contentType = localClip.contentType;
    const client = getGeminiClient();

    try {
      // The whole Gemini exchange retries as one unit, not just generateContent:
      // a demand spike can land on the upload or the file poll just as easily, and
      // an uploaded file reference is only useful to the call that follows it.
      // Parsing and validation deliberately sit outside, so model drift is never
      // retried — a re-roll of the same prompt is not a fix for a bad schema.
      const response = await withTransientRetry(async () => {
        // The SDK's files.upload takes a path or a Blob; the path form is what
        // keeps the clip out of memory. The temp file outlives every retry, so
        // a re-upload costs nothing extra.
        const uploaded = await client.files.upload({
          file: localClip.path,
          config: { mimeType: contentType },
        });

        if (!uploaded.name || !uploaded.uri) {
          throw new Error('Gemini upload did not return a usable file reference');
        }
        if (uploaded.state !== FileState.ACTIVE) {
          await waitUntilActive(client, uploaded.name);
        }

        return client.models.generateContent({
          model: TAGGING_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType ?? contentType } },
                { text: TAGGING_PROMPT },
              ],
            },
          ],
          config: { responseMimeType: 'application/json' },
        });
      }, TAGGING_RETRY);

      let parsed: z.infer<typeof TaggingResponseSchema>;
      try {
        parsed = TaggingResponseSchema.parse(JSON.parse(response.text ?? ''));
      } catch (validationError) {
        // Keep the underlying cause: this string is the only diagnostic later
        // stages have when the model drifts off the requested shape.
        return {
          success: false,
          error: `Gemini returned invalid or unparseable JSON for tagging: ${describeCause(validationError)}`,
        };
      }

      // Re-tagging a clip replaces its segments rather than appending, so a retry
      // after a partial failure cannot leave duplicate rows behind.
      await db.transaction(async (tx) => {
        await tx.delete(segments).where(eq(segments.rawClipId, rawClipId));
        await tx.insert(segments).values(
          parsed.segments.map((s) => ({
            rawClipId,
            startSeconds: s.startSeconds.toString(),
            endSeconds: s.endSeconds.toString(),
            contentTag: s.contentTag,
            qualityTag: s.qualityTag,
          }))
        );
      });

      return { success: true, segmentCount: parsed.segments.length };
    } finally {
      // Runs on every exit path, including the early returns above, so a job
      // cannot fill the worker's temp directory with abandoned videos.
      await localClip.cleanUp();
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
