import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips, segments, editPlans, creators } from '@/db/schema';
import { getGeminiClient } from '@/lib/gemini/client';
import { HOOK_STYLE_LIBRARY } from '@/lib/pipeline/hookLibrary';
import { describeCause } from '@/lib/pipeline/errors';

// Pro models (2.5-pro, 3.x-pro) return 429 quota-exceeded on the free API tier,
// so the director runs on Flash too. Revisit if plan quality proves insufficient
// and billing is enabled — this is the step that would benefit most from Pro.
const DIRECTOR_MODEL = 'gemini-3.6-flash';

// One initial call plus two correction retries, as specified for this step.
const MAX_ATTEMPTS = 3;

// Correction notes are fed back to the model, where a longer excerpt of the
// validation failure is genuinely useful; the stored failure reason stays short.
const MAX_CORRECTION_NOTE_LENGTH = 1500;

// A variation's cuts must sum to within this fraction of the job's target length.
const DURATION_TOLERANCE = 0.15;

// The only placements Stage 3 can render. This single constant both builds the
// prompt and validates the response, so the two cannot drift apart.
const OVERLAY_PLACEMENTS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

// Separator between the measurement fields we assemble ourselves.
const MEASUREMENT_SEPARATOR = ' · ';

/**
 * Any digit immediately followed by a length/weight unit. The creator's real
 * height and weight come from their profile and are assembled in code; a model
 * that writes measurements itself is inventing them, which would burn fabricated
 * body stats into a real creator's published video.
 */
const FABRICATED_MEASUREMENT =
  /\d\s*(?:lbs?|pounds?|kgs?|kilos?|cm|mm|ft|feet|foot|in(?:ch(?:es)?)?\b|['"′″])/i;

type Job = typeof jobs.$inferSelect;
type Creator = typeof creators.$inferSelect;

/** A segment as offered to the model: times as numbers, not drizzle's numeric strings. */
type PoolSegment = {
  id: string;
  rawClipId: string;
  startSeconds: number;
  endSeconds: number;
  contentTag: string | null;
  qualityTag: string | null;
};

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
  // Only ever a lead-in phrase; the measurements are appended in code.
  sizingOverlayText: z.string().nullable(),
  sizingOverlayPlacement: z.enum(OVERLAY_PLACEMENTS).nullable(),
});

const DirectorResponseSchema = z.object({
  variations: z.array(VariationSchema).min(1),
});

type DirectorResponse = z.infer<typeof DirectorResponseSchema>;

type ValidationContext = {
  expectedVariationCount: number;
  targetLengthSeconds: number;
  footageEndByClipId: Map<string, number>;
  sizingOverlayEnabled: boolean;
};

/**
 * Wraps the structural schema with the checks that need this job's context:
 * the exact variation count that was ordered, the target length, the footage
 * that actually exists, and the rule that the model never authors measurements.
 * Anything that survives this is safe for the renderer to execute.
 */
function buildValidator(context: ValidationContext) {
  const { expectedVariationCount, targetLengthSeconds, footageEndByClipId, sizingOverlayEnabled } =
    context;

  return DirectorResponseSchema.superRefine((value, ctx) => {
    if (value.variations.length !== expectedVariationCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['variations'],
        message: `expected exactly ${expectedVariationCount} variations, received ${value.variations.length}`,
      });
    }

    value.variations.forEach((variation, variationIndex) => {
      const variationPath = ['variations', variationIndex];

      const totalSeconds = variation.segments.reduce(
        (sum, s) => sum + (s.endSeconds - s.startSeconds),
        0
      );
      const allowedDrift = targetLengthSeconds * DURATION_TOLERANCE;
      // Epsilon keeps an exactly-on-the-boundary total from failing on float noise.
      if (Math.abs(totalSeconds - targetLengthSeconds) > allowedDrift + 1e-9) {
        ctx.addIssue({
          code: 'custom',
          path: [...variationPath, 'segments'],
          message: `total duration ${totalSeconds}s is not within ${Math.round(
            DURATION_TOLERANCE * 100
          )}% of the ${targetLengthSeconds}s target length`,
        });
      }

      if (sizingOverlayEnabled && variation.sizingOverlayText) {
        if (FABRICATED_MEASUREMENT.test(variation.sizingOverlayText)) {
          ctx.addIssue({
            code: 'custom',
            path: [...variationPath, 'sizingOverlayText'],
            message:
              "sizingOverlayText must not contain any height, weight or size measurement; write only a short lead-in phrase, the creator's real measurements are appended automatically",
          });
        }
      }

      variation.segments.forEach((segment, segmentIndex) => {
        const path = [...variationPath, 'segments', segmentIndex];

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

/**
 * Builds the overlay caption from stored values only: the creator's profile
 * measurements and the size they recorded for this job. The model may supply a
 * lead-in phrase, never a number. Returns null when there is nothing truthful to
 * show, so a job with an unfilled profile degrades to no overlay rather than a
 * broken or invented one.
 */
function buildSizingOverlayText(
  creator: Creator,
  job: Job,
  leadIn: string | null
): string | null {
  const measurements = [
    creator.height,
    creator.weight,
    job.sizeWorn ? `size ${job.sizeWorn}` : null,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  if (measurements.length === 0) return null;

  const caption = measurements.join(MEASUREMENT_SEPARATOR);
  const phrase = leadIn?.trim();
  return phrase ? `${phrase} ${caption}` : caption;
}

function buildPrompt(job: Job, segmentPool: PoolSegment[], correctionNote?: string): string {
  const placements = OVERLAY_PLACEMENTS.map((p) => `"${p}"`).join(', ');
  const sizingInstruction = job.sizingOverlayEnabled
    ? `This ad shows a sizing overlay. The creator's real height and weight are appended automatically from their stored profile${
        job.sizeWorn ? `, along with the size worn: ${job.sizeWorn}` : ''
      }. So write sizingOverlayText as a short lead-in phrase ONLY (for example "For reference" or "Fit check") and never write any height, weight, or size numbers yourself - you do not know them and inventing them is not acceptable. Set sizingOverlayPlacement to one of: ${placements}.`
    : 'Set sizingOverlayText and sizingOverlayPlacement to null.';

  return `You are editing a short-form UGC ad video for the product "${job.productName}".
Target length: ${job.lengthSeconds} seconds. Pacing: ${job.pacing}.
Produce exactly ${job.variationCount} distinct variations.

Available segments (choose from these only, by rawClipId):
${JSON.stringify(segmentPool)}

Each variation's segment durations must sum to within ${Math.round(
    DURATION_TOLERANCE * 100
  )}% of the target length.
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
    // The creator is joined in because their stored height/weight are the only
    // legitimate source for sizing-overlay measurements.
    const [row] = await db
      .select({ job: jobs, creator: creators })
      .from(jobs)
      .innerJoin(creators, eq(jobs.creatorId, creators.id))
      .where(eq(jobs.id, jobId));
    if (!row) return { success: false, error: `Job ${jobId} not found` };
    const { job, creator } = row;

    const clips = await db.select().from(rawClips).where(eq(rawClips.jobId, jobId));
    const poolRows =
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

    if (poolRows.length === 0) {
      return { success: false, error: 'No usable segments were found for this job' };
    }

    // Drizzle returns numeric columns as strings; the model is asked to answer
    // in numbers, so offer the pool in numbers too rather than making it convert.
    const segmentPool: PoolSegment[] = poolRows.map((s) => ({
      id: s.id,
      rawClipId: s.rawClipId,
      startSeconds: Number(s.startSeconds),
      endSeconds: Number(s.endSeconds),
      contentTag: s.contentTag,
      qualityTag: s.qualityTag,
    }));

    // The furthest tagged end time per clip is the most footage we know exists,
    // so it bounds what the director is allowed to cut.
    const footageEndByClipId = new Map<string, number>();
    for (const segment of segmentPool) {
      footageEndByClipId.set(
        segment.rawClipId,
        Math.max(footageEndByClipId.get(segment.rawClipId) ?? 0, segment.endSeconds)
      );
    }

    const validator = buildValidator({
      expectedVariationCount: job.variationCount,
      targetLengthSeconds: job.lengthSeconds,
      footageEndByClipId,
      sizingOverlayEnabled: job.sizingOverlayEnabled,
    });
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
        variations.map((v, index) => {
          // Never persist overlay copy for a job that turned the overlay off,
          // and never persist a caption the model wrote the numbers for; Stage 3
          // renders whatever is stored here.
          const overlayText = job.sizingOverlayEnabled
            ? buildSizingOverlayText(creator, job, v.sizingOverlayText)
            : null;

          return {
            jobId,
            variationNumber: index + 1,
            segments: v.segments,
            hookText: v.hookText,
            sizingOverlayText: overlayText,
            // A placement without a caption would render an empty overlay.
            sizingOverlayPlacement: overlayText ? v.sizingOverlayPlacement : null,
          };
        })
      );
    });

    return { success: true, variationCount: variations.length };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
