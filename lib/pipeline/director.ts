import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips, segments, editPlans, creators } from '@/db/schema';
import { getEnvWithDefault } from '@/lib/env';
import { getGeminiClient } from '@/lib/gemini/client';
import { HOOK_STYLE_LIBRARY } from '@/lib/pipeline/hookLibrary';
import { describeCause } from '@/lib/pipeline/errors';
import { withTransientRetry, type TransientRetryOptions } from '@/lib/pipeline/retry';

// Pro models (2.5-pro, 3.x-pro) return 429 quota-exceeded on the free API tier,
// so the director runs on Flash too. Overridable so a Pro model can be selected
// once billing is enabled without a code change — this is the step that would
// benefit most from Pro, since it reasons against several hard constraints at once.
const DIRECTOR_MODEL = getEnvWithDefault('GEMINI_DIRECTOR_MODEL', 'gemini-3.6-flash');

// One initial call plus two correction retries, as specified for this step.
// This budget is for *validation* failures only: a 503 is not the model getting
// the answer wrong, so it must not consume one of these attempts. Transient
// errors are retried inside the call itself (see DIRECTOR_RETRY) and never
// reach the correction-note loop.
const MAX_ATTEMPTS = 3;

/** Matches the tagging step's policy; see the note on TAGGING_RETRY. */
const DIRECTOR_RETRY: TransientRetryOptions = {
  attempts: 3,
  baseDelayMs: 1000,
  label: 'Gemini director call',
};

/**
 * How many times one segment may appear in a single variation.
 *
 * The first live run produced a 12-cut variation built from 3 unique segments —
 * technically legal under the old "never twice in a row" rule and technically
 * inside the duration tolerance, but unwatchable. Two is the smallest cap that
 * still honours the design's explicit allowance for reuse: seeing a moment twice
 * reads as a deliberate callback or bookend in short-form UGC, while a third
 * appearance reads as padding. It also bounds the worst case tightly — with N
 * unique segments a variation can never exceed 2N cuts.
 */
const MAX_SEGMENT_REUSE = 2;

/**
 * When two cuts from the same clip count as the same footage.
 *
 * The reuse cap used to key on the exact `rawClipId|start|end` triple, which is
 * both too strict and too loose now that the director is actively told to split
 * long segments. Splitting 0-8s into 0-4s and 4-8s is genuinely two different
 * moments and must not count as a repeat; nudging a boundary (0-8s then 0.1-8s)
 * is the same moment wearing a disguise and must.
 *
 * The line is drawn at *more than half of the shorter cut*: past that point the
 * majority of the shorter cut is footage the viewer has already seen, so it
 * reads as a repeat. At or below it, most of the cut is new. Exactly-half
 * overlap (0-4s and 2-6s) stays legal, which keeps evenly-staggered subdivision
 * available to the model.
 */
const SAME_FOOTAGE_OVERLAP_RATIO = 0.5;

/**
 * How much footage two neighbouring cuts from one clip must throw away between
 * them before the splice reads as a cut.
 *
 * The second live run produced a variation of seven cuts — 0-4, 4-8, 8-12,
 * 12-16, 16-20, 20-24, 24-27 — all from one clip. Every existing rule passed:
 * the cuts are in the pacing band, none overlap, none repeat. But concatenating
 * chronologically-adjacent ranges of one continuous take just replays the take,
 * so the viewer sees *zero* cuts. The pacing rule reported success while
 * delivering the exact opposite of what it exists to guarantee.
 *
 * One second is the smallest gap that reliably reads as a scene change rather
 * than a dropped frame: in handheld UGC the subject, framing and hands all move
 * appreciably in a second, so the splice looks deliberate. Below that it reads
 * as a stutter or an encoding glitch. It is also at or above the shortest cut
 * any preset allows (`fast` floors at 0.75s), so the discarded material is a
 * real beat rather than rounding noise, and it costs at most ~1s of footage per
 * same-clip splice — cheap enough that the pool measurement absorbs it.
 *
 * Measured as the absolute distance between the previous cut's end and the next
 * cut's start, so a backwards jump (playing an earlier part of the clip next)
 * satisfies it too: non-chronological order reads as a cut all by itself.
 */
const MIN_CUT_GAP_SECONDS = 1;

/**
 * Shortest variation the near-identical-sequence check applies to.
 *
 * The check rejects neighbouring variations that match in all but one position.
 * On a two-cut variation that bar is unreachable once the distinct-opening rule
 * has already forced position 0 apart, so applying it there would reject plans
 * that are as different as the pool allows. Three is the shortest length where
 * "all but one position matches" describes a genuinely lazy copy.
 */
const MIN_CUTS_FOR_SEQUENCE_DISTINCTNESS = 3;

/**
 * Seconds per cut for each pacing preset, taken verbatim from the product spec:
 * "Slow ~5-6s/clip, Medium ~3-4s/clip, Fast ~1-2s/clip". The whole product is
 * fast-cut UGC pacing, so this is a core requirement, not a stylistic hint.
 */
const PACING_PRESET_SECONDS: Record<Job['pacing'], { min: number; max: number }> = {
  slow: { min: 5, max: 6 },
  medium: { min: 3, max: 4 },
  fast: { min: 1, max: 2 },
};

/**
 * How far outside its preset a single cut may sit before it stops reading as
 * the requested pace. 25% widens medium to 2.25-5s: loose enough that the model
 * has room to hit the total-length target without threading a needle, tight
 * enough that the live run's 14s and 16s opening shots are rejected outright.
 */
const PACING_TOLERANCE = 0.25;

/**
 * The last cut of a variation may fall this far below the band's floor.
 *
 * Landing exactly on the total-length target sometimes leaves a remainder, and
 * a short final beat before the video ends is ordinary editing rather than a
 * pacing failure. The exception is deliberately one-sided: nothing is allowed
 * to run *longer* than the band, because a long tail cut (the live run ended a
 * variation on 13.5s) is precisely the defect being fixed.
 */
const FINAL_CUT_FLOOR_RATIO = 0.5;

// Correction notes are fed back to the model, where a longer excerpt of the
// validation failure is genuinely useful; the stored failure reason stays short.
const MAX_CORRECTION_NOTE_LENGTH = 1500;

/**
 * How far a variation's total may fall *below* the job's target length.
 *
 * Was 15% in both directions. The second live run answered a 30s job with
 * 25.5s, 26.0s, 26.0s, 26.5s and 27.0s — every one legal, every one 10-15%
 * short. A window of +-15% on a 30s job is +-4.5s, wider than a whole medium
 * cut, so "add one more cut" and "stop here" are both legal and the model
 * reliably picks the cheaper one. Tightening the floor to 10% (3s on a 30s job,
 * less than one cut) means landing short is no longer free: four of those five
 * variations would now be rejected.
 */
const DURATION_UNDER_TOLERANCE = 0.1;

/**
 * How far a variation's total may run *over* the target. Left at the original
 * 15%: overshoot has never been observed, and tightening a boundary with no
 * evidence behind it only buys retries. The band is deliberately asymmetric
 * because the defect is one-sided.
 */
const DURATION_OVER_TOLERANCE = 0.15;

/**
 * The tighter window the prompt asks for. The model treats whatever number it
 * is given as the edge of acceptable, so it is given a target narrower than the
 * validator enforces; "close enough" then lands inside the accepted band with
 * room to spare instead of on its floor.
 */
const DURATION_AIM_TOLERANCE = 0.05;

/**
 * Slack allowed against `maxAchievableSeconds` when the pool cannot reach the
 * target at all.
 *
 * Looser than the target tolerances on purpose. That ceiling is our own
 * estimate ("every second of footage, shown twice"), and `MIN_CUT_GAP_SECONDS`
 * makes part of it structurally unreachable: a single-clip pool must discard
 * about a second at every same-clip splice, which costs roughly a seventh of a
 * short clip's doubled length. The floor exists only to stop the model throwing
 * usable footage away, so it is set well below the estimate rather than
 * chasing it — 25% still rejects a 4s plan when 14s was achievable, which is
 * the case it was written for.
 */
const FALLBACK_FLOOR_TOLERANCE = 0.25;

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

/**
 * Accepts either the requested `{variations: [...]}` wrapper or a bare `[...]`
 * array of variations.
 *
 * The tagging step hit exactly this and was fixed the same way: the model
 * returns the wrapper most of the time but drops it under load or on weaker
 * models, and a live run failed all three correction attempts on nothing but
 * the missing wrapper. Both shapes carry identical information, and the wrapper
 * is our formatting preference rather than something any caller depends on, so
 * normalising is strictly better than spending the retry budget on it. Every
 * variation is still validated identically either way.
 */
const DirectorResponseSchema = z
  .union([
    z.object({ variations: z.array(VariationSchema).min(1) }),
    z.array(VariationSchema).min(1),
  ])
  .transform((value) => (Array.isArray(value) ? { variations: value } : value));

type DirectorResponse = z.infer<typeof DirectorResponseSchema>;

/** The allowed length of a single cut, in seconds, for one pacing preset. */
type PacingBand = { min: number; max: number };

type ValidationContext = {
  expectedVariationCount: number;
  targetLengthSeconds: number;
  footageEndByClipId: Map<string, number>;
  sizingOverlayEnabled: boolean;
  footage: PoolCapacity;
  pacing: Job['pacing'];
  pacingBand: PacingBand;
};

/** What the tagged segment pool can physically produce under the reuse cap. */
type PoolCapacity = {
  /** Distinct segments offered, counted once each however many rows repeat them. */
  uniqueSegmentCount: number;
  /** Seconds of distinct footage the pool covers; overlapping tags count once. */
  availableSeconds: number;
  /** The longest edit those segments can fill without breaking the reuse cap. */
  maxAchievableSeconds: number;
  /** False when the pool cannot reach the bottom of the target's tolerance band. */
  isSufficient: boolean;
  /**
   * Whether the pool holds two band-length cuts that are not the same moment.
   * Below this line a variation cannot repeat anything, and neighbouring
   * variations cannot be given different opening shots, so both rules that
   * depend on having a choice are switched off rather than made unsatisfiable.
   */
  hasTwoDistinctCuts: boolean;
};

/** Identity of a *tagged* segment, used to de-duplicate the offered pool. */
function segmentKey(segment: { rawClipId: string; startSeconds: number; endSeconds: number }): string {
  return `${segment.rawClipId}|${segment.startSeconds}|${segment.endSeconds}`;
}

type Cut = { rawClipId: string; startSeconds: number; endSeconds: number };

/** Widest allowed length for one cut under a pacing preset. */
function bandFor(pacing: Job['pacing']): PacingBand {
  const preset = PACING_PRESET_SECONDS[pacing];
  return {
    min: preset.min * (1 - PACING_TOLERANCE),
    max: preset.max * (1 + PACING_TOLERANCE),
  };
}

/** Trims float noise so messages read as "3.5s", never "3.4999999999999996s". */
function round2(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

function cutDuration(cut: Cut): number {
  return cut.endSeconds - cut.startSeconds;
}

/**
 * Whether two cuts show substantially the same moment. Used both for the reuse
 * cap and for the no-repeat-back-to-back rule, so the same moment cannot appear
 * consecutively under two slightly different boundaries either.
 */
function isSameFootage(a: Cut, b: Cut): boolean {
  if (a.rawClipId !== b.rawClipId) return false;
  const shorter = Math.min(cutDuration(a), cutDuration(b));
  if (shorter <= 0) return false;
  const overlap = Math.min(a.endSeconds, b.endSeconds) - Math.max(a.startSeconds, b.startSeconds);
  return overlap > shorter * SAME_FOOTAGE_OVERLAP_RATIO + 1e-9;
}

/** Total length covered by a set of possibly-overlapping intervals. */
function unionSeconds(intervals: { start: number; end: number }[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let covered = 0;
  let cursor = -Infinity;
  for (const { start, end } of sorted) {
    const from = Math.max(start, cursor);
    if (end > from) {
      covered += end - from;
      cursor = end;
    }
  }
  return covered;
}

/**
 * Measures the pool before the director is asked for anything, so "there simply
 * is not enough footage" is a fact we establish ourselves rather than something
 * we hope the model notices.
 *
 * Footage is measured as the *union* of each clip's tagged ranges, not the sum
 * of them. The tagging step always emits a whole-clip segment plus any distinct
 * good moments inside it, so summing would count a 10s clip tagged twice as 14s
 * of footage and quietly license showing it three times over — the exact
 * padding this measurement exists to prevent. It is also the number the
 * creator-facing warning quotes, and "you gave us 10s" has to be true.
 *
 * Screen time, not cut count, is what the ceiling measures, so subdivision does
 * not raise it: splitting 0-8s into 0-4s and 4-8s still spends 8 seconds of
 * footage. `available x MAX_SEGMENT_REUSE` therefore remains exactly "every
 * second of footage shown at most twice" under the overlap-based reuse rule.
 *
 * What subdivision *does* change is whether the doubling is reachable at all.
 * The old special case ("a single tagged segment cannot be repeated, because
 * its second use would sit next to its first") is no longer true: one 15s
 * segment now splits into cuts that alternate perfectly well. The real
 * condition is whether the footage is long enough to yield two cuts that are
 * not the same moment, which is a question about seconds, not about how many
 * rows the tagger happened to emit.
 */
function measurePool(
  pool: PoolSegment[],
  targetLengthSeconds: number,
  band: PacingBand
): PoolCapacity {
  const uniqueSegments = new Map<string, PoolSegment>();
  for (const segment of pool) uniqueSegments.set(segmentKey(segment), segment);

  const rangesByClip = new Map<string, { start: number; end: number }[]>();
  for (const segment of uniqueSegments.values()) {
    const ranges = rangesByClip.get(segment.rawClipId) ?? [];
    ranges.push({ start: segment.startSeconds, end: segment.endSeconds });
    rangesByClip.set(segment.rawClipId, ranges);
  }

  const availableSeconds = [...rangesByClip.values()].reduce(
    (sum, ranges) => sum + unionSeconds(ranges),
    0
  );
  // Two band-length cuts have to fit in the footage before anything can be
  // repeated without the repeat sitting next to its original.
  const canRepeat = availableSeconds >= 2 * band.min - 1e-9;
  const maxAchievableSeconds = canRepeat ? availableSeconds * MAX_SEGMENT_REUSE : availableSeconds;

  return {
    uniqueSegmentCount: uniqueSegments.size,
    availableSeconds,
    maxAchievableSeconds,
    // Epsilon keeps a pool that lands exactly on the boundary out of the
    // fallback path, matching how the duration check itself rounds. Measured
    // against the *floor* of the accepted band, because that is the shortest
    // total a sufficient pool will be allowed to produce.
    isSufficient:
      maxAchievableSeconds >= targetLengthSeconds * (1 - DURATION_UNDER_TOLERANCE) - 1e-9,
    hasTwoDistinctCuts: canRepeat,
  };
}

/**
 * Plain-language note for the creator when their upload could not fill the
 * length they asked for. Deliberately not a failure: a short video is a usable
 * result, and the actionable part is "upload more clips".
 */
export function buildShortFootageWarning(
  availableSeconds: number,
  targetLengthSeconds: number
): string {
  return (
    `Only ${Math.round(availableSeconds)}s of usable footage was available, so your videos are ` +
    `shorter than the ${targetLengthSeconds}s you requested. Upload more clips for full-length videos.`
  );
}

/**
 * Wraps the structural schema with the checks that need this job's context:
 * the exact variation count that was ordered, the target length, the footage
 * that actually exists, and the rule that the model never authors measurements.
 * Anything that survives this is safe for the renderer to execute.
 */
function buildValidator(context: ValidationContext) {
  const {
    expectedVariationCount,
    targetLengthSeconds,
    footageEndByClipId,
    sizingOverlayEnabled,
    footage,
    pacing,
    pacingBand,
  } = context;

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
      if (footage.isSufficient) {
        // Asymmetric: the observed defect is variations that stop short, so the
        // floor is the tighter of the two. Epsilon keeps an exactly-on-the-
        // boundary total from failing on float noise.
        const floor = targetLengthSeconds * (1 - DURATION_UNDER_TOLERANCE);
        const ceiling = targetLengthSeconds * (1 + DURATION_OVER_TOLERANCE);
        if (totalSeconds < floor - 1e-9 || totalSeconds > ceiling + 1e-9) {
          ctx.addIssue({
            code: 'custom',
            path: [...variationPath, 'segments'],
            message:
              `total duration ${round2(totalSeconds)}s misses the ${targetLengthSeconds}s target ` +
              `length: every variation must total between ${round2(floor)}s and ${round2(
                ceiling
              )}s, and should land close to ${targetLengthSeconds}s rather than at the edge of ` +
              `that window`,
          });
        }
      } else {
        // Not enough footage exists to reach the target without repeating
        // segments past the cap, so the target becomes "as much as the footage
        // can honestly fill". Only a floor is checked: the reuse cap below is
        // what stops the total climbing, and a short video beats a padded one.
        const achievableFloor = footage.maxAchievableSeconds * (1 - FALLBACK_FLOOR_TOLERANCE);
        if (totalSeconds < achievableFloor - 1e-9) {
          ctx.addIssue({
            code: 'custom',
            path: [...variationPath, 'segments'],
            message:
              `total duration ${totalSeconds}s wastes the available footage: this job only has ` +
              `${footage.availableSeconds}s of distinct footage, so aim for about ` +
              `${footage.maxAchievableSeconds}s rather than the ${targetLengthSeconds}s target`,
          });
        }
      }

      // The rule the first live run needed and did not have: 3 segments were
      // looped 12 times, legally under the consecutive-repeat rule alone.
      //
      // Counted by overlap rather than exact identity, so that subdividing a
      // long segment into distinct moments is free while re-showing one moment
      // under nudged boundaries is not. Each cut is compared against every
      // other cut in the variation; the issue is raised only from the earliest
      // member of a group so one repeat does not produce three identical
      // complaints.
      variation.segments.forEach((segment, segmentIndex) => {
        const showsSameMoment = (other: Cut, otherIndex: number) =>
          otherIndex === segmentIndex || isSameFootage(segment, other);
        const uses = variation.segments.filter(showsSameMoment).length;
        if (uses <= MAX_SEGMENT_REUSE) return;
        if (variation.segments.findIndex(showsSameMoment) !== segmentIndex) return;
        ctx.addIssue({
          code: 'custom',
          path: [...variationPath, 'segments'],
          message:
            `the footage at ${segment.rawClipId} ${round2(segment.startSeconds)}-` +
            `${round2(segment.endSeconds)}s is used ${uses} times in this variation ` +
            `(counting cuts that overlap it by more than half); no moment may be used more than ` +
            `${MAX_SEGMENT_REUSE} times. Cutting a different, non-overlapping part of the same ` +
            `clip does not count as a repeat`,
        });
      });

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

        // Pacing: the reason this product exists is constant clip changes, and
        // until now it was only prose in the prompt. The live run answered a
        // 30s medium job with a single unbroken 14s opening shot.
        const duration = cutDuration(segment);
        const isFinalCut = segmentIndex === variation.segments.length - 1;
        // A clip with less usable footage than the band's floor cannot produce
        // a cut that long, so demanding one would make the job unsatisfiable.
        const floorApplies = footageEnd >= pacingBand.min - 1e-9;
        const floor = isFinalCut ? pacingBand.min * FINAL_CUT_FLOOR_RATIO : pacingBand.min;
        if (duration > pacingBand.max + 1e-9) {
          ctx.addIssue({
            code: 'custom',
            path,
            message:
              `this cut is ${round2(duration)}s long, but "${pacing}" pacing means every cut must ` +
              `be between ${round2(pacingBand.min)}s and ${round2(pacingBand.max)}s. Split this ` +
              `footage into shorter cuts and place them at different points in the video instead ` +
              `of using it as one long take`,
          });
        } else if (floorApplies && duration < floor - 1e-9) {
          ctx.addIssue({
            code: 'custom',
            path,
            message:
              `this cut is only ${round2(duration)}s long, but "${pacing}" pacing means every cut ` +
              `must be between ${round2(pacingBand.min)}s and ${round2(pacingBand.max)}s` +
              (isFinalCut
                ? ` (the final cut of a variation may go as low as ${round2(floor)}s)`
                : ''),
          });
        }

        const previous = variation.segments[segmentIndex - 1];
        if (previous && isSameFootage(previous, segment)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message:
              'the same segment must not appear in two consecutive positions; these two cuts ' +
              'overlap by more than half, so they show the same moment twice in a row',
          });
        } else if (previous && previous.rawClipId === segment.rawClipId) {
          // The defect the seven-cut live variation exposed: 0-4 then 4-8 then
          // 8-12 out of one continuous take passes every other rule and yet
          // produces no visible cut, because concatenating adjacent ranges just
          // replays the take. A splice is only visible if footage was thrown
          // away at it, or if the next cut jumps backwards.
          const jump = Math.abs(segment.startSeconds - previous.endSeconds);
          if (jump < MIN_CUT_GAP_SECONDS - 1e-9) {
            ctx.addIssue({
              code: 'custom',
              path,
              message:
                `this cut continues the previous one from the same clip with only ` +
                `${round2(jump)}s between them, so playing them back to back replays the ` +
                `original take and the viewer sees no cut at all. Two neighbouring cuts from ` +
                `one clip must either leave at least ${MIN_CUT_GAP_SECONDS}s of footage out ` +
                `between them (${round2(previous.startSeconds)}-${round2(
                  previous.endSeconds
                )}s then ${round2(previous.endSeconds + MIN_CUT_GAP_SECONDS)}s or later), or ` +
                `jump backwards to an earlier part of the clip`,
            });
          }
        }
      });
    });

    // Structural distinctness between variations.
    //
    // The product's premise is N *different* edits of one shoot. The second
    // live run returned five variations sharing one skeleton — long-clip chunk,
    // short clip, long-clip chunk — with variations 4 and 5 differing only in
    // hook text and a single substituted cut. Nothing checked it, because every
    // rule until now looked at one variation at a time.
    //
    // Only neighbouring variations are compared. Comparing every pair would
    // scale the difficulty as O(n^2) on a pool that may only hold a handful of
    // distinct moments, and a chain in which each variation differs from the
    // one before it is already the thing being asked for.
    if (footage.hasTwoDistinctCuts) {
      for (let index = 1; index < value.variations.length; index++) {
        const previous = value.variations[index - 1].segments;
        const current = value.variations[index].segments;
        if (previous.length === 0 || current.length === 0) continue;
        const path = ['variations', index, 'segments'];

        // Cheapest and most visible difference: the first thing the viewer sees.
        if (isSameFootage(previous[0], current[0])) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 0],
            message:
              `this variation opens on the same footage as variation ${index} ` +
              `(${current[0].rawClipId} ${round2(current[0].startSeconds)}-` +
              `${round2(current[0].endSeconds)}s). Consecutive variations must be different ` +
              `edits, not one edit with a new hook: start this one on a different moment`,
          });
        }

        // "Different hook, one clip swapped" — the exact shape variations 4 and
        // 5 took. Compared position by position, so reordering the same cuts
        // counts as a different edit, which is what it looks like on screen.
        if (
          previous.length === current.length &&
          current.length >= MIN_CUTS_FOR_SEQUENCE_DISTINCTNESS
        ) {
          const matching = current.filter((cut, position) =>
            isSameFootage(previous[position], cut)
          ).length;
          if (matching >= current.length - 1) {
            ctx.addIssue({
              code: 'custom',
              path,
              message:
                `this variation is the same edit as variation ${index}: ${matching} of its ` +
                `${current.length} cuts are the same footage in the same position. Change the ` +
                `order, the subdivision boundaries and which moments are used - at least two ` +
                `positions must differ`,
            });
          }
        }
      }
    }
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

function buildPrompt(
  job: Job,
  segmentPool: PoolSegment[],
  footage: PoolCapacity,
  band: PacingBand,
  correctionNote?: string
): string {
  const placements = OVERLAY_PLACEMENTS.map((p) => `"${p}"`).join(', ');
  const sizingInstruction = job.sizingOverlayEnabled
    ? `This ad shows a sizing overlay. The creator's real height and weight are appended automatically from their stored profile${
        job.sizeWorn ? `, along with the size worn: ${job.sizeWorn}` : ''
      }. So write sizingOverlayText as a short lead-in phrase ONLY (for example "For reference" or "Fit check") and never write any height, weight, or size numbers yourself - you do not know them and inventing them is not acceptable. Set sizingOverlayPlacement to one of: ${placements}.`
    : 'Set sizingOverlayText and sizingOverlayPlacement to null.';

  // When the pool cannot fill the requested length, the model is told the real
  // ceiling instead of the target it cannot reach, so it stops padding.
  //
  // The accepted window is stated too, but the *aim* is stated first and
  // tighter: the live run showed the model treating whatever bound it is given
  // as the goal, so the goal it is given has to be the target itself.
  const durationFloor = round2(job.lengthSeconds * (1 - DURATION_UNDER_TOLERANCE));
  const durationCeiling = round2(job.lengthSeconds * (1 + DURATION_OVER_TOLERANCE));
  const aimFloor = round2(job.lengthSeconds * (1 - DURATION_AIM_TOLERANCE));
  const aimCeiling = round2(job.lengthSeconds * (1 + DURATION_AIM_TOLERANCE));
  const durationInstruction = footage.isSufficient
    ? `TOTAL LENGTH: AIM FOR ${job.lengthSeconds} SECONDS.
Add up your cut durations: every variation should land between ${aimFloor}s and ${aimCeiling}s.
A total below ${durationFloor}s or above ${durationCeiling}s is rejected outright, but do not aim for ${durationFloor}s -
the creator asked for ${job.lengthSeconds}s, and a variation that stops short is a worse edit, not a safer one.
If your total is under ${aimFloor}s, add another cut before you answer.`
    : `There is only ${footage.availableSeconds}s of distinct footage in the pool, which cannot fill the
${job.lengthSeconds}s target within the reuse limit below. Do NOT pad the video by repeating segments.
Aim instead for a total of about ${footage.maxAchievableSeconds}s per variation - a shorter video is
much better than a repetitive one.`;

  // Pacing is the product: constant clip changes are what makes this read as a
  // UGC ad rather than a home video. It is stated as hard numbers, and the same
  // band is enforced in code, so the instruction and the validator agree.
  const preset = PACING_PRESET_SECONDS[job.pacing];
  const approximateCuts = Math.max(
    2,
    Math.round(job.lengthSeconds / ((preset.min + preset.max) / 2))
  );
  const pacingInstruction = `PACING IS THE MOST IMPORTANT RULE. "${job.pacing}" pacing means every single cut
must last between ${round2(band.min)} and ${round2(band.max)} seconds, ideally around ${preset.min}-${preset.max} seconds.
A ${job.lengthSeconds}s video at this pacing is roughly ${approximateCuts} cuts, not a handful of long takes. A cut longer than
${round2(band.max)}s will be rejected: one unbroken shot destroys the fast-cut feel this format depends on.
Only the FINAL cut of a variation may be shorter than ${round2(band.min)}s (down to ${round2(
    band.min * FINAL_CUT_FLOOR_RATIO
  )}s) if you need it to land on the target length.

A listed segment is a RANGE YOU MAY CUT INSIDE, not a fixed block: you choose any startSeconds and
endSeconds you like within a clip's listed footage. So when a good segment is longer than ${round2(band.max)}s,
SPLIT IT into several shorter cuts and place them at DIFFERENT POINTS in the video rather than using it
as one long take. An 8s segment becomes, for example, a cut early in the video and a separate,
non-overlapping cut later on. This is how you reach ${approximateCuts} cuts from a handful of long clips.`;

  // The rule the seven-cut live variation needed and did not have. Stated in
  // the prompt as well as enforced, so the model aims for it rather than
  // discovering it through three correction rounds.
  const visibleCutInstruction = `EVERY CUT MUST BE VISIBLE. Splitting a clip is only a cut if footage is thrown away at the
splice. If two cuts NEXT TO EACH OTHER in the sequence come from the same clip, they must not be
chronologically adjacent: leave at least ${MIN_CUT_GAP_SECONDS}s of footage OUT between them, or make the second cut
jump BACKWARDS to an earlier part of the clip.
  WRONG: 0-4 then 4-8 then 8-12 from one clip. That is the original take playing straight through -
  the viewer sees no cut at all, and it will be rejected however many "cuts" you list.
  RIGHT: 0-4 then 5-9 then 10-14 (a second of footage discarded at each splice), or 0-4 then 12-16
  then 6-10 (out of order), or interleave a different clip between them.
A ${MIN_CUT_GAP_SECONDS}s gap costs you almost nothing and is what makes the edit read as edited.`;

  // The product is N different edits of one shoot, not one edit with N hooks.
  const distinctnessInstruction =
    job.variationCount > 1
      ? `THE ${job.variationCount} VARIATIONS MUST BE STRUCTURALLY DIFFERENT EDITS, not one edit with different hook text.
Each variation must differ from the one before it in ALL of these ways:
- a different OPENING shot (a different moment, not the same shot re-trimmed);
- a different ORDER (do not reuse one skeleton with a single clip swapped out);
- different SUBDIVISION BOUNDARIES (if variation 1 splits a clip 0-4 / 8-12, variation 2 should
  split it somewhere else, e.g. 2-6 / 13-17), and a different number of cuts where the length allows.
Two neighbouring variations that match in every position but one will be rejected.`
      : '';

  return `You are editing a short-form UGC ad video for the product "${job.productName}".
Target length: ${job.lengthSeconds} seconds. Pacing: ${job.pacing}.
Produce exactly ${job.variationCount} distinct variations.

Available segments (choose from these only, by rawClipId):
${JSON.stringify(segmentPool)}

${pacingInstruction}

${visibleCutInstruction}

${durationInstruction}
${distinctnessInstruction}
If there are not enough distinct good segments to reach the target length, you may reuse a moment,
but never in two consecutive positions in the sequence and never more than ${MAX_SEGMENT_REUSE} times in
the same variation. Two cuts count as the SAME moment when they come from the same clip and overlap by
more than half of the shorter one - so nudging a boundary (0-8 then 0.1-8) is still a repeat, while two
non-overlapping cuts from one clip are different footage and are exactly what you should be doing,
provided they obey the visible-cut rule above when they sit next to each other.
If you ever have to choose between padding a variation and letting it run short, let it run short.
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
): Promise<
  | { success: true; variationCount: number; warning: string | null }
  | { success: false; error: string }
> {
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

    // The per-cut length the job's pacing preset asks for, used to build the
    // prompt, to validate the response, and to judge what the pool can reach.
    const band = bandFor(job.pacing);

    // Established before the model is asked for anything: whether the creator's
    // upload can honestly fill the length they asked for.
    const footage = measurePool(segmentPool, job.lengthSeconds, band);

    const validator = buildValidator({
      expectedVariationCount: job.variationCount,
      targetLengthSeconds: job.lengthSeconds,
      footageEndByClipId,
      sizingOverlayEnabled: job.sizingOverlayEnabled,
      footage,
      pacing: job.pacing,
      pacingBand: band,
    });
    const client = getGeminiClient();

    let correctionNote: string | undefined;
    let lastFailure: unknown;
    let parsed: DirectorResponse | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Transient failures are absorbed here rather than in the loop below: a
      // 503 is not a wrong answer, so it must neither spend one of the three
      // validation attempts nor turn into a correction note telling the model
      // to fix a response it never got to give.
      const response = await withTransientRetry(
        () =>
          client.models.generateContent({
            model: DIRECTOR_MODEL,
            contents: [
              {
                role: 'user',
                parts: [{ text: buildPrompt(job, segmentPool, footage, band, correctionNote) }],
              },
            ],
            config: { responseMimeType: 'application/json' },
          }),
        DIRECTOR_RETRY
      );

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

    // A short video is a usable result, so this is a note for the creator, not
    // a failure. Always written (null included) so re-planning a job whose
    // footage has since grown clears the stale warning.
    const warning = footage.isSufficient
      ? null
      : buildShortFootageWarning(footage.availableSeconds, job.lengthSeconds);

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

      await tx.update(jobs).set({ warning }).where(eq(jobs.id, jobId));
    });

    return { success: true, variationCount: variations.length, warning };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
