import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { FileState, type GoogleGenAI } from '@google/genai';
import { db } from '@/db/client';
import { rawClips, segments } from '@/db/schema';
import { downloadClipToTempFile } from '@/lib/storage';
import { probeMedia } from '@/lib/render/ffmpeg';
import { getEnvWithDefault } from '@/lib/env';
import { getGeminiClient } from '@/lib/gemini/client';
import { describeCause } from '@/lib/pipeline/errors';
import { recordUsage } from '@/lib/pipeline/usage';
import { parseFirstJsonValue } from '@/lib/pipeline/json';
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
 * of six clips on the first live run.
 *
 * Widened from 3 tries over ~2s after a live job died to a sustained spike: the
 * old window was sized for a blip and gave up while the model was still busy.
 * Five tries backing off to ~16s covers about half a minute, which is the
 * shape these outages actually have, and costs nothing when the first call
 * succeeds.
 */
const TAGGING_RETRY: TransientRetryOptions = {
  attempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 16000,
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

const TAGGING_PROMPT = `You are indexing a raw video clip so an editor can build several DIFFERENT short-form
UGC ad cuts from it. Your job is to find EVERY distinct usable moment, not to summarize the clip.

Return MANY short segments — aim for one every 2-4 seconds of usable footage. A 30-second clip
should yield roughly 8-15 segments, not 2 or 3. Each segment should be a single coherent moment:
a specific action, angle, or beat (a turn, a close-up of a detail, a full-body shot, a gesture).
Keep them mostly 2-6 seconds long. Overlapping segments are fine when a stretch works both as a
quick beat and as part of a longer one.

Do NOT return one or two giant blocks covering the whole clip — that is the failure case. The
editor builds distinct variations by drawing DIFFERENT subsets of your segments, so a handful of
large segments forces every variation to reuse the same footage. More, smaller, specific moments
is always better.

Also include exactly one segment spanning the entire clip (start 0 to full duration) tagged
contentTag "whole-clip", as a fallback — but it is in ADDITION to the granular segments above,
never instead of them.

Tag each segment's contentTag as one of: "whole-clip", "b-roll" (product on its own / detail /
environment), "try-on" (person wearing or using the product), "other".
Tag qualityTag as "low", "medium", or "high" by how usable the moment is — steady footage, clear
subject, good lighting, strong composition. Be discerning: this score is how the editor picks the
best moments, so do not mark everything "high".

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

/** Shortest tagged segment worth keeping once it has been clamped. */
const MIN_SEGMENT_SECONDS = 0.5;

/**
 * Discards or trims tagged segments that run past the end of the clip.
 *
 * The model invents them. On a real 77-second clip it returned segments out to
 * 117s — forty seconds of footage that does not exist — and because nothing
 * checked, those timings were stored, the director planned cuts inside them,
 * and four of ten variations died at render with "cut starts at 110s, past the
 * end of 77.1s of picture". The creator got six videos instead of ten and no
 * explanation.
 *
 * This is the same discipline the talking editor already applies: the model is
 * good at saying *what* is in a recording and unreliable about *when*, so every
 * number it gives about time is checked against the file itself.
 *
 * Segments starting past the end are dropped outright; ones that merely
 * overrun are trimmed back, then dropped if what remains is too short to cut.
 */
export function clampSegmentsToClip<T extends { startSeconds: number; endSeconds: number }>(
  tagged: T[],
  clipDurationSeconds: number
): { kept: T[]; droppedCount: number; trimmedCount: number } {
  const kept: T[] = [];
  let droppedCount = 0;
  let trimmedCount = 0;

  for (const segment of tagged) {
    if (segment.startSeconds >= clipDurationSeconds) {
      droppedCount += 1;
      continue;
    }
    if (segment.endSeconds <= clipDurationSeconds) {
      kept.push(segment);
      continue;
    }
    const trimmed = { ...segment, endSeconds: clipDurationSeconds };
    if (trimmed.endSeconds - trimmed.startSeconds < MIN_SEGMENT_SECONDS) {
      droppedCount += 1;
      continue;
    }
    trimmedCount += 1;
    kept.push(trimmed);
  }

  return { kept, droppedCount, trimmedCount };
}

export async function tagClip(
  rawClipId: string
): Promise<{ success: true; segmentCount: number } | { success: false; error: string }> {
  try {
    const [clip] = await db.select().from(rawClips).where(eq(rawClips.id, rawClipId));
    if (!clip) return { success: false, error: `Raw clip ${rawClipId} not found` };

    /*
     * Already tagged: return what is stored instead of paying for it again.
     *
     * A job that fails after tagging -- most likely at the planning call, which
     * is a single point of failure at the end of a four-minute stage -- used to
     * restart from nothing on retry, re-uploading every clip to Gemini and
     * spending the daily quota a second time for an answer already in the
     * database. Tagging is deterministic enough that re-running it buys nothing.
     */
    const existing = await db.select().from(segments).where(eq(segments.rawClipId, rawClipId));
    if (existing.length > 0) {
      return { success: true, segmentCount: existing.length };
    }

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

      // Metered before the response is validated: the call was billed whether
      // or not the model returned usable JSON, so recording it only on the
      // success path would under-report exactly the spend worth noticing.
      await recordUsage({
        jobId: clip.jobId,
        kind: 'tagging',
        model: TAGGING_MODEL,
        usage: response.usageMetadata,
      });

      let parsed: z.infer<typeof TaggingResponseSchema>;
      try {
        parsed = TaggingResponseSchema.parse(parseFirstJsonValue(response.text ?? ''));
      } catch (validationError) {
        // Keep the underlying cause: this string is the only diagnostic later
        // stages have when the model drifts off the requested shape.
        return {
          success: false,
          error: `Gemini returned invalid or unparseable JSON for tagging: ${describeCause(validationError)}`,
        };
      }

      /*
       * Measured from the file, never taken from the model.
       *
       * Clamped against the *picture* rather than the container, because a
       * clip's audio can outlast its video and a cut past the last frame is
       * exactly the failure this prevents.
       */
      const media = await probeMedia(localClip.path);
      const clipDuration = Math.min(
        ...[media.video?.duration ?? null, media.containerDuration].filter(
          (value): value is number => value !== null
        )
      );

      const { kept, droppedCount, trimmedCount } = Number.isFinite(clipDuration)
        ? clampSegmentsToClip(parsed.segments, clipDuration)
        : { kept: parsed.segments, droppedCount: 0, trimmedCount: 0 };

      if (droppedCount > 0 || trimmedCount > 0) {
        console.warn(
          `Clip ${rawClipId}: the tagger returned segments past the end of a ` +
            `${clipDuration.toFixed(1)}s clip — dropped ${droppedCount}, trimmed ${trimmedCount}.`
        );
      }

      if (kept.length === 0) {
        return {
          success: false,
          error: `Every tagged segment fell outside this clip's ${clipDuration.toFixed(1)}s of footage`,
        };
      }

      // Re-tagging a clip replaces its segments rather than appending, so a retry
      // after a partial failure cannot leave duplicate rows behind.
      await db.transaction(async (tx) => {
        await tx.delete(segments).where(eq(segments.rawClipId, rawClipId));
        await tx.insert(segments).values(
          kept.map((s) => ({
            rawClipId,
            startSeconds: s.startSeconds.toString(),
            endSeconds: s.endSeconds.toString(),
            contentTag: s.contentTag,
            qualityTag: s.qualityTag,
          }))
        );
      });

      return { success: true, segmentCount: kept.length };
    } finally {
      // Runs on every exit path, including the early returns above, so a job
      // cannot fill the worker's temp directory with abandoned videos.
      await localClip.cleanUp();
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
