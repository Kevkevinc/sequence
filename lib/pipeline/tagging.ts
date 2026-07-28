import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { FileState, type GoogleGenAI } from '@google/genai';
import { db } from '@/db/client';
import { rawClips, segments } from '@/db/schema';
import { getClipBuffer } from '@/lib/storage';
import { getGeminiClient } from '@/lib/gemini/client';

const TAGGING_MODEL = 'gemini-2.5-flash';

// How long to wait for Gemini to finish processing an uploaded video before
// giving up: 30 polls x 2s = up to ~60s.
const FILE_POLL_ATTEMPTS = 30;
const FILE_POLL_INTERVAL_MS = 2000;

const TaggingResponseSchema = z.object({
  segments: z
    .array(
      z.object({
        startSeconds: z.number().min(0),
        endSeconds: z.number().min(0),
        contentTag: z.string(),
        qualityTag: z.string(),
      })
    )
    .min(1),
});

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

    const { buffer, contentType } = await getClipBuffer(clip.storageKey);
    const client = getGeminiClient();

    // The SDK's files.upload only accepts a file path or a Blob, so wrap the
    // in-memory clip bytes rather than passing the Buffer directly.
    const uploaded = await client.files.upload({
      file: new Blob([new Uint8Array(buffer)], { type: contentType }),
      config: { mimeType: contentType },
    });

    if (!uploaded.name || !uploaded.uri) {
      throw new Error('Gemini upload did not return a usable file reference');
    }
    if (uploaded.state !== FileState.ACTIVE) {
      await waitUntilActive(client, uploaded.name);
    }

    const response = await client.models.generateContent({
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

    let parsed: z.infer<typeof TaggingResponseSchema>;
    try {
      parsed = TaggingResponseSchema.parse(JSON.parse(response.text ?? ''));
    } catch {
      return { success: false, error: 'Gemini returned invalid or unparseable JSON for tagging' };
    }

    await db.insert(segments).values(
      parsed.segments.map((s) => ({
        rawClipId,
        startSeconds: s.startSeconds.toString(),
        endSeconds: s.endSeconds.toString(),
        contentTag: s.contentTag,
        qualityTag: s.qualityTag,
      }))
    );

    return { success: true, segmentCount: parsed.segments.length };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
