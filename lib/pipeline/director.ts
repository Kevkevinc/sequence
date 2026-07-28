import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips, segments, editPlans } from '@/db/schema';
import { getGeminiClient } from '@/lib/gemini/client';
import { HOOK_STYLE_LIBRARY } from '@/lib/pipeline/hookLibrary';
import { describeCause } from '@/lib/pipeline/errors';

const DIRECTOR_MODEL = 'gemini-2.5-pro';

// One initial call plus two correction retries, as specified for this step.
const MAX_ATTEMPTS = 3;

// Correction notes are fed back to the model, where a longer excerpt of the
// validation failure is genuinely useful; the stored failure reason stays short.
const MAX_CORRECTION_NOTE_LENGTH = 1500;

type Job = typeof jobs.$inferSelect;
type Segment = typeof segments.$inferSelect;

const SegmentSelectionSchema = z
  .object({
    rawClipId: z.uuid(),
    startSeconds: z.number().min(0),
    endSeconds: z.number().min(0),
  })
  // A zero- or negative-duration cut is not renderable, so treat it as model
  // drift rather than persisting a plan the renderer cannot execute.
  .refine((s) => s.endSeconds > s.startSeconds, {
    message: 'endSeconds must be greater than startSeconds',
  });

const VariationSchema = z.object({
  segments: z.array(SegmentSelectionSchema).min(1),
  hookText: z.string().min(1),
  sizingOverlayText: z.string().nullable(),
  sizingOverlayPlacement: z.string().nullable(),
});

const DirectorResponseSchema = z.object({
  variations: z.array(VariationSchema).min(1),
});

type DirectorResponse = z.infer<typeof DirectorResponseSchema>;

/**
 * Wraps the structural schema with the checks that need this job's context:
 * the exact variation count that was ordered, and the footage that actually
 * exists. Anything that survives this is safe for the renderer to execute.
 */
function buildValidator(expectedVariationCount: number, footageEndByClipId: Map<string, number>) {
  return DirectorResponseSchema.superRefine((value, ctx) => {
    if (value.variations.length !== expectedVariationCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['variations'],
        message: `expected exactly ${expectedVariationCount} variations, received ${value.variations.length}`,
      });
    }

    value.variations.forEach((variation, variationIndex) => {
      variation.segments.forEach((segment, segmentIndex) => {
        const path = ['variations', variationIndex, 'segments', segmentIndex];

        const footageEnd = footageEndByClipId.get(segment.rawClipId);
        if (footageEnd === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'rawClipId'],
            message: `rawClipId ${segment.rawClipId} is not one of the clips offered for this job`,
          });
          return;
        }

        if (segment.endSeconds > footageEnd) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'endSeconds'],
            message: `endSeconds ${segment.endSeconds} runs past the end of that clip's usable footage (${footageEnd}s)`,
          });
        }

        const previous = variation.segments[segmentIndex - 1];
        if (
          previous &&
          previous.rawClipId === segment.rawClipId &&
          previous.startSeconds === segment.startSeconds &&
          previous.endSeconds === segment.endSeconds
        ) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: 'the same segment must not appear in two consecutive positions',
          });
        }
      });
    });
  });
}

function buildPrompt(job: Job, segmentPool: Segment[], correctionNote?: string): string {
  const sizingInstruction = job.sizingOverlayEnabled
    ? `This ad shows a sizing overlay${job.sizeWorn ? ` (size worn: ${job.sizeWorn})` : ''}. Write sizingOverlayText as a short on-screen fit note and sizingOverlayPlacement as one of "top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right".`
    : 'Set sizingOverlayText and sizingOverlayPlacement to null.';

  return `You are editing a short-form UGC ad video for the product "${job.productName}".
Target length: ${job.lengthSeconds} seconds. Pacing: ${job.pacing}.
Produce exactly ${job.variationCount} distinct variations.

Available segments (choose from these only, by rawClipId):
${JSON.stringify(
  segmentPool.map((s) => ({
    id: s.id,
    rawClipId: s.rawClipId,
    startSeconds: s.startSeconds,
    endSeconds: s.endSeconds,
    contentTag: s.contentTag,
    qualityTag: s.qualityTag,
  }))
)}

Each variation's segments should sum to within 15% of the target length.
If there are not enough distinct good segments to reach the target length, you may
reuse a segment more than once, but never in two consecutive positions in the sequence.
Never reference a rawClipId that is not listed above, and never let endSeconds run past
the end of that clip's listed footage.

Hook text should be adapted from this style library to fit the product (not copied verbatim):
${JSON.stringify(HOOK_STYLE_LIBRARY)}

${sizingInstruction}
${correctionNote ? `\nYour previous response was invalid: ${correctionNote}\nPlease fix it.\n` : ''}
Respond with JSON only, matching this shape:
{"variations": [{"segments": [{"rawClipId": string, "startSeconds": number, "endSeconds": number}], "hookText": string, "sizingOverlayText": string | null, "sizingOverlayPlacement": string | null}]}`;
}

export async function planJob(
  jobId: string
): Promise<{ success: true; variationCount: number } | { success: false; error: string }> {
  try {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job) return { success: false, error: `Job ${jobId} not found` };

    const clips = await db.select().from(rawClips).where(eq(rawClips.jobId, jobId));
    const segmentPool =
      clips.length === 0
        ? []
        : await db
            .select()
            .from(segments)
            .where(
              inArray(
                segments.rawClipId,
                clips.map((c) => c.id)
              )
            );

    if (segmentPool.length === 0) {
      return { success: false, error: 'No usable segments were found for this job' };
    }

    // The furthest tagged end time per clip is the most footage we know exists,
    // so it bounds what the director is allowed to cut.
    const footageEndByClipId = new Map<string, number>();
    for (const segment of segmentPool) {
      const end = Number(segment.endSeconds);
      footageEndByClipId.set(segment.rawClipId, Math.max(footageEndByClipId.get(segment.rawClipId) ?? 0, end));
    }

    const validator = buildValidator(job.variationCount, footageEndByClipId);
    const client = getGeminiClient();

    let correctionNote: string | undefined;
    let lastFailure: unknown;
    let parsed: DirectorResponse | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const response = await client.models.generateContent({
        model: DIRECTOR_MODEL,
        contents: [{ role: 'user', parts: [{ text: buildPrompt(job, segmentPool, correctionNote) }] }],
        config: { responseMimeType: 'application/json' },
      });

      try {
        parsed = validator.parse(JSON.parse(response.text ?? ''));
        break;
      } catch (validationError) {
        // Feed the specific reason back into the next attempt: a blind re-roll
        // would very likely repeat the same mistake.
        lastFailure = validationError;
        correctionNote = describeCause(validationError, MAX_CORRECTION_NOTE_LENGTH);
        parsed = undefined;
      }
    }

    if (!parsed) {
      return {
        success: false,
        error: `Gemini did not produce a valid edit plan after ${MAX_ATTEMPTS} attempts: ${describeCause(lastFailure)}`,
      };
    }

    const variations = parsed.variations;

    // Re-planning a job replaces its plans rather than appending, so a retry
    // after a partial failure cannot leave stale variations behind.
    await db.transaction(async (tx) => {
      await tx.delete(editPlans).where(eq(editPlans.jobId, jobId));
      await tx.insert(editPlans).values(
        variations.map((v, index) => ({
          jobId,
          variationNumber: index + 1,
          segments: v.segments,
          hookText: v.hookText,
          // Never persist overlay copy for a job that turned the overlay off;
          // Stage 3 renders whatever is stored here.
          sizingOverlayText: job.sizingOverlayEnabled ? v.sizingOverlayText : null,
          sizingOverlayPlacement: job.sizingOverlayEnabled ? v.sizingOverlayPlacement : null,
        }))
      );
    });

    return { success: true, variationCount: variations.length };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
