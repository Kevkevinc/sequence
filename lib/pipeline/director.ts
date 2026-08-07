import { z } from 'zod';
import { FinishReason } from '@google/genai';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips, segments, editPlans, creators, styles } from '@/db/schema';
import { OVERLAY_PLACEMENTS } from '@/lib/editPlan';
import { FIT_INSPO } from '@/lib/render/fitInspo';
import { getEnvWithDefault } from '@/lib/env';
import { getGeminiClient } from '@/lib/gemini/client';
import { StyleConfigSchema, type StyleConfig } from '@/lib/styles';
import { hooksForAudience, type HookAudience } from '@/lib/pipeline/hookLibrary';
import { describeCause, MAX_CAUSE_LENGTH } from '@/lib/pipeline/errors';
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
 * "fast is 1-2s. medium is 1.5-4s. slow is 4-7s". The whole product is fast-cut
 * UGC pacing, so this is a core requirement, not a stylistic hint.
 *
 * The bands deliberately overlap (fast 1-2 sits inside medium 1.5-4): they name
 * the feel a creator asked for, not a partition of the number line, and a 1.8s
 * cut is legitimately available to either.
 *
 * Keyed on `NonNullable<Job['pacing']>` because the column is nullable now:
 * a Style-mode job carries no named preset at all and gets its band from
 * `styles.config` instead (see `resolvePreset`).
 */
const PACING_PRESET_SECONDS: Record<NonNullable<Job['pacing']>, { min: number; max: number }> = {
  slow: { min: 4, max: 7 },
  medium: { min: 1.5, max: 4 },
  fast: { min: 1, max: 2 },
};

/**
 * How far outside its preset a single cut may sit before it stops reading as
 * the requested pace. 25% widens medium to 2.25-5s: loose enough that the model
 * has room to hit the total-length target without threading a needle, tight
 * enough that the live run's 14s and 16s opening shots are rejected outright.
 */
const PACING_TOLERANCE = 0.25;

/** How long the Fit Inspo intro covers the frame, mirrored from the renderer. */
const FIT_INSPO_INTRO_SECONDS = FIT_INSPO.clearsAtSeconds;

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
//
// The budget is spent on *distinct* problems, one per variation per round (see
// `summarizeIssues`), rather than on `ZodError.message` — which runs ~290 chars
// per issue, admits about five, emits them in variation order, and so showed a
// five-variation job nothing but variation 0's complaints on every attempt.
const MAX_CORRECTION_NOTE_LENGTH = 1500;

/** Joins the individual problems inside a correction note. */
const CORRECTION_NOTE_SEPARATOR = '; ';

/** Room reserved for the "(and N more problems)" tail, so the cap still holds. */
const CORRECTION_NOTE_TAIL_BUDGET = 32;

/**
 * Longest on-screen hook the renderer can lay out.
 *
 * Nothing bounded this before, and Stage 3 has to fit the hook on a 9:16 frame:
 * beyond roughly two lines of large type it either overflows or shrinks to
 * unreadable. 120 characters is comfortably longer than every entry in the hook
 * style library (the longest is 58) while ruling out a paragraph.
 */
const MAX_HOOK_LENGTH = 120;

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
 * Looser than the target tolerances on purpose: the ceiling is our own estimate
 * of what the pool can yield, and the floor exists only to stop the model
 * throwing usable footage away rather than to hit a number. 25% still rejects a
 * 3s plan when ~12s was achievable, which is the case it was written for.
 *
 * Since `maxAchievableSeconds` now discounts the gap loss (see `measurePool`),
 * this floor is a genuinely reachable number: for `fast` pacing it works out at
 * `1.07 x availableSeconds`, comfortably under the ~1.43x a straightforward
 * chronological edit yields. Before the discount it was `1.5 x available`,
 * i.e. above what `fast` can produce — the rescue path could itself fail.
 */
const FALLBACK_FLOOR_TOLERANCE = 0.25;

/**
 * How much of the estimated capacity we refuse to count on when deciding
 * whether a pool can be held to the strict target band.
 *
 * `isSufficient` is a one-way door: saying yes commits the job to
 * `[0.9T, 1.15T]` with no fallback, so being wrong by a second means three
 * rejected attempts and a hard failure. Saying no costs a warning and a
 * shorter video. The estimate below it is a *model* of what a straightforward
 * chronological edit yields, and a real edit lands a little under it (a 20s
 * clip at `medium` estimates 33.3s and the best hand-built plan we have is
 * 31s — 93%). 15% is comfortably below that observed 93% while still leaving
 * "20s of footage, 30s medium target" on the strict path, which subdivision
 * genuinely reaches.
 *
 * It is deliberately *not* `FALLBACK_FLOOR_TOLERANCE`. Reusing 25% would make
 * the two floors meet exactly at the crossover, which is elegant, but it also
 * demands `maxAchievable >= 1.2T` before a job is called sufficient — pushing
 * jobs that comfortably reach their target into the short-footage path, where
 * the creator is told their video will be short when it will not be.
 */
const CAPACITY_SAFETY_MARGIN = 0.15;

// Placements live in the shared EditPlan contract (see lib/editPlan.ts) because
// the renderer needs the same list. This single constant both builds the prompt
// and validates the response, so prompt and validator cannot drift apart, and
// sharing it means planning and rendering cannot drift apart either.

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
  // Capped because Stage 3 has to render this on a 9:16 frame; an unbounded
  // hook is unlayoutable rather than merely ugly.
  hookText: z.string().min(1).max(MAX_HOOK_LENGTH),
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
  /**
   * How the band is described back to the model when a cut breaks it. A label
   * rather than the raw pacing enum, because a Style-mode job has no enum to
   * name — see `EffectivePreset.label`.
   */
  pacingLabel: string;
  pacingBand: PacingBand;
  /** The tagged pool itself, so a cut can be attributed to a content tag. */
  taggedPool: PoolSegment[];
  /**
   * One ordering pattern per variation, or null when this job does not vary its
   * clip order at all — either the style does not ask for it, or the footage has
   * only one of the two tags and there is nothing to order.
   */
  orderPatterns: OrderPattern[] | null;
};

/** What the tagged segment pool can physically produce under the reuse cap. */
type PoolCapacity = {
  /** Distinct segments offered, counted once each however many rows repeat them. */
  uniqueSegmentCount: number;
  /** Seconds of distinct footage the pool covers; overlapping tags count once. */
  availableSeconds: number;
  /**
   * The longest edit the pool can realistically fill under the reuse cap *and*
   * the minimum-gap rule. Not the theoretical ceiling — see `measurePool`.
   */
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

/**
 * Everything the prompt and validator need, resolved uniformly from either a
 * named pacing preset (Custom mode) or a style's config (Style mode) — every
 * later rule reads this instead of branching on `job.pacing` vs `job.styleId`.
 */
type EffectivePreset = {
  /** The "ideal" per-cut range named in the prompt, before pacing tolerance widens it. */
  ideal: { min: number; max: number };
  /** Reads naturally in "${label} means every cut must be between...". */
  label: string;
  hookStyleLibrary: readonly string[];
  /** Non-null when the style pins one corner for every variation. */
  sizingPlacementOverride: (typeof OVERLAY_PLACEMENTS)[number] | null;
  variesClipOrder: boolean;
  /**
   * Whether the render opens on the Fit Inspo intro.
   *
   * The director needs to know because the first seconds are spent with
   * reference images stacked over the footage: whatever cut is playing then is
   * background, so the strongest moment should not be spent there.
   */
  opensOnIntro: boolean;
};

/**
 * Resolves the job's editing preset. `style` is defined exactly when
 * `job.styleId` is set — see the lookup in `planJob`. Its `config` is the
 * already-`StyleConfigSchema`-validated value, not a re-cast of the raw JSONB
 * column, so this function never needs to (and must not) trust `styles.config`
 * directly.
 */
function resolvePreset(
  job: Job,
  style: { name: string; config: StyleConfig } | undefined,
  audience: HookAudience
): EffectivePreset {
  if (style) {
    return {
      ideal: { min: style.config.cutMinSeconds, max: style.config.cutMaxSeconds },
      label: `the "${style.name}" style`,
      hookStyleLibrary: hooksForCreator(style.config.hookStyleLibrary, audience),
      sizingPlacementOverride: style.config.sizingPlacement ?? null,
      variesClipOrder: style.config.variesClipOrder,
      opensOnIntro: style.config.usesFitInspoIntro,
    };
  }
  return {
    ideal: PACING_PRESET_SECONDS[job.pacing!],
    label: `"${job.pacing}" pacing`,
    hookStyleLibrary: hooksForAudience(audience),
    /*
     * Pinned, not left to the model.
     *
     * Custom mode used to let the director choose a placement per variation,
     * and a live five-variation job came back with five different ones --
     * including `top-center`, which lands the block at the middle of the upper
     * half of the frame: directly over the creator's face in a vertical try-on.
     * There is no editorial reason for the sizing block to move between
     * variations of the same shoot, and one corner is the only placement that
     * is reliably clear of the subject.
     */
    sizingPlacementOverride: 'bottom-right',
    variesClipOrder: false,
    opensOnIntro: false,
  };
}

/**
 * Narrows a style's hook library to the lines that suit this creator's
 * audience.
 *
 * A bare string is an untagged legacy entry and counts as neutral. If filtering
 * would leave nothing — a style whose whole library is coded for the other
 * audience — the full library is used rather than handing the director an empty
 * list, since a mismatched register still beats no reference at all.
 */
function hooksForCreator(
  library: StyleConfig['hookStyleLibrary'],
  audience: HookAudience
): string[] {
  const all = library.map((entry) => (typeof entry === 'string' ? entry : entry.text));
  const suited = library
    .filter(
      (entry) =>
        typeof entry === 'string' || entry.audience === 'any' || entry.audience === audience
    )
    .map((entry) => (typeof entry === 'string' ? entry : entry.text));
  return suited.length > 0 ? suited : all;
}

/**
 * Widest allowed length for one cut, from either preset source.
 *
 * Exported so tests derive the widened band instead of hard-coding the
 * arithmetic: the presets above are product settings the creator retunes, and
 * duplicated numbers meant every retune broke a dozen unrelated assertions.
 */
export function bandForPacing(pacing: NonNullable<Job['pacing']>): PacingBand {
  return bandForPreset(PACING_PRESET_SECONDS[pacing]);
}

function bandForPreset(ideal: { min: number; max: number }): PacingBand {
  return {
    min: ideal.min * (1 - PACING_TOLERANCE),
    max: ideal.max * (1 + PACING_TOLERANCE),
  };
}

/**
 * How the b-roll and try-on halves of a shoot are arranged in one variation.
 *
 * Some styles are defined as much by their running order as by their pacing: the
 * dupe-flip look opens on the product in isolation and pays it off with the
 * try-on, while the same footage led by the try-on reads as a haul. A style that
 * sets `variesClipOrder` wants the batch to cover both readings rather than
 * hand the creator five takes on one structure, so the pattern is assigned per
 * variation rather than per job.
 */
type OrderPattern = 'broll-first' | 'tryon-first' | 'mixed';

const ORDER_PATTERNS: readonly OrderPattern[] = ['broll-first', 'tryon-first', 'mixed'];

/**
 * Cycles through the three patterns by variation index, so a batch mixes it up.
 *
 * Cycling rather than randomising means a two-variation job always gets the two
 * opposed structures (the interesting contrast) and never two of the same, and
 * the assignment is reproducible — the prompt and the validator derive it
 * independently and must agree.
 */
function orderPatternsForVariations(count: number): OrderPattern[] {
  return Array.from({ length: count }, (_, i) => ORDER_PATTERNS[i % ORDER_PATTERNS.length]);
}

function orderingRuleText(pattern: OrderPattern): string {
  switch (pattern) {
    case 'broll-first':
      return 'every segment tagged "b-roll" must come before every segment tagged "try-on"';
    case 'tryon-first':
      return 'every segment tagged "try-on" must come before every segment tagged "b-roll"';
    case 'mixed':
      return 'no ordering constraint between "b-roll" and "try-on" segments - arrange them however makes the best edit';
  }
}

/** Trims float noise so messages read as "3.5s", never "3.4999999999999996s". */
/**
 * The one-word noun a person would actually say for a product.
 *
 * "Black Streetwear Zip-up" is a retail title; nobody says it out loud, and a
 * hook containing it reads as an ad rather than someone talking. The last word
 * is almost always the noun ("zip-up", "hoodie", "jeans") with everything
 * before it a modifier, so this takes that and gives it to the model as an
 * example of the right shape — not as a token to substitute, which is the
 * failure mode bracket placeholders caused.
 */
function shortProductNoun(productName: string): string {
  const words = productName.trim().split(/\s+/).filter(Boolean);
  return (words[words.length - 1] ?? productName).toLowerCase();
}

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

/**
 * Which content tag a cut mostly overlaps, ignoring "whole-clip"/"other" (both
 * unconstrained by the ordering rule). A cut whose majority falls outside any
 * b-roll/try-on tagged range is unconstrained too.
 *
 * Majority rather than any-overlap on purpose: the director is told a listed
 * segment is a range it may cut inside, so a cut is free to straddle the
 * boundary between two tagged ranges. Attributing such a cut to whichever tag
 * it barely clips would make the ordering rule reject edits that read exactly
 * as the pattern asks, and there is no honest answer for a cut that is half of
 * each — so those go unconstrained rather than guessed at.
 */
function cutContentTag(cut: Cut, taggedPool: PoolSegment[]): 'b-roll' | 'try-on' | null {
  let bestTag: 'b-roll' | 'try-on' | null = null;
  let bestOverlap = 0;
  for (const segment of taggedPool) {
    if (segment.rawClipId !== cut.rawClipId) continue;
    if (segment.contentTag !== 'b-roll' && segment.contentTag !== 'try-on') continue;
    const overlap =
      Math.min(cut.endSeconds, segment.endSeconds) - Math.max(cut.startSeconds, segment.startSeconds);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestTag = segment.contentTag;
    }
  }
  return bestOverlap > cutDuration(cut) / 2 ? bestTag : null;
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
 *
 * `available x 2` is nonetheless the *theoretical* ceiling, and quoting it as
 * the achievable one was actively harmful. `MIN_CUT_GAP_SECONDS` makes a
 * pacing-dependent slice of it unreachable in practice: a straightforward
 * chronological edit of one clip spends `cut + 1` seconds of timeline for every
 * `cut` seconds of screen time, so it yields `band.max / (band.max + gap)` of
 * theory — 88% on `slow`, 83% on `medium`, only 71% on `fast`. Measuring
 * sufficiency against the undiscounted ceiling created a band in which a job
 * was routed onto the strict target path while its realistic yield sat below
 * that path's floor, so *more* footage turned a succeeding job into a failing
 * one. The ceiling is therefore discounted here, once, and every consumer —
 * `isSufficient`, the fallback floor, the number quoted in the prompt — gets
 * the honest figure.
 *
 * A model that orders its cuts non-chronologically pays no gap at all and can
 * beat this estimate; that is fine, because nothing is capped by it. It is only
 * ever used as a lower bound on what to *ask* for.
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
  // Two band-length cuts have to fit in the footage before the pool can offer
  // two different opening shots. Different variations may use adjacent cuts, so
  // no gap is needed for this question — it is about how much distinct footage
  // exists, nothing else.
  const hasTwoDistinctCuts = availableSeconds >= 2 * band.min - 1e-9;

  // Repeating a moment *within* one variation is a stricter requirement: the
  // repeat needs another cut between it and its original, and on a single-clip
  // pool that neighbouring cut has to be separated by the minimum gap. Without
  // the gap term a 5s clip at `medium` claimed it could fill 8.3s when 5s is
  // all it can legally produce, and the fallback floor became unsatisfiable.
  const canRepeat = availableSeconds >= 2 * band.min + MIN_CUT_GAP_SECONDS - 1e-9;

  // What a chronological edit actually keeps: `band.max` of screen time for
  // every `band.max + gap` of timeline it walks through.
  const gapEfficiency = band.max / (band.max + MIN_CUT_GAP_SECONDS);
  const maxAchievableSeconds = canRepeat
    ? availableSeconds * MAX_SEGMENT_REUSE * gapEfficiency
    : availableSeconds;

  return {
    uniqueSegmentCount: uniqueSegments.size,
    availableSeconds,
    maxAchievableSeconds,
    // Epsilon keeps a pool that lands exactly on the boundary out of the
    // fallback path, matching how the duration check itself rounds. Measured
    // against the *floor* of the accepted band, because that is the shortest
    // total a sufficient pool will be allowed to produce, and discounted by
    // CAPACITY_SAFETY_MARGIN because committing to that floor is a one-way
    // door: a pool that is declared sufficient and then cannot reach the floor
    // has no fallback and fails outright.
    isSufficient:
      maxAchievableSeconds * (1 - CAPACITY_SAFETY_MARGIN) >=
      targetLengthSeconds * (1 - DURATION_UNDER_TOLERANCE) - 1e-9,
    hasTwoDistinctCuts,
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
 * Turns a validation failure into the note the next attempt is given.
 *
 * Built from `error.issues` rather than `ZodError.message` for two reasons the
 * correction loop cannot work without:
 *
 *  - **Deduplication.** A variation with twelve identical pacing violations
 *    used to spend the entire note repeating one sentence twelve times.
 *  - **Round-robin across variations.** `superRefine` emits in variation order,
 *    and `ZodError.message` runs ~290 characters per issue, so a 1500-character
 *    note admitted roughly five issues — all of them variation 0's. A
 *    five-variation job with a systemic problem therefore fixed variation 0,
 *    resubmitted, saw variation 1's complaints for the first time, and ran out
 *    of the three-attempt budget having never been told about variations 3 and
 *    4. It could not converge however good the model was. Interleaving means
 *    every variation contributes one problem before any contributes a second.
 *
 * Anything that is not a `ZodError` (a `SyntaxError` from `JSON.parse`, say)
 * falls through to the plain description.
 */
/**
 * A Zod issue, flattened to just the two fields the note needs.
 *
 * `invalid_union` carries its real detail in a nested `errors` array — one
 * entry per union branch — and reports only "Invalid input" itself. The
 * response schema *is* a union (the `{variations: [...]}` wrapper or a bare
 * array), so without unwrapping this every structural failure would come back
 * to the model as the single word "Invalid input" with nothing to act on.
 */
type FlatIssue = { path: PropertyKey[]; message: string };

function flattenIssues(issues: readonly unknown[], prefix: PropertyKey[] = []): FlatIssue[] {
  const flattened: FlatIssue[] = [];
  for (const raw of issues) {
    const issue = raw as { code?: string; path?: PropertyKey[]; message: string; errors?: unknown[][] };
    const path = [...prefix, ...(issue.path ?? [])];
    if (issue.code === 'invalid_union' && Array.isArray(issue.errors)) {
      for (const branch of issue.errors) flattened.push(...flattenIssues(branch, path));
      continue;
    }
    flattened.push({ path, message: issue.message });
  }
  return flattened;
}

function summarizeIssues(error: unknown, maxLength: number): string {
  if (!(error instanceof z.ZodError)) return describeCause(error, maxLength);

  // Keyed by message text, not by the full line: eight cuts breaking the pacing
  // band by the same amount produce eight issues carrying one sentence, and
  // saying it once (against the first offending path) is the whole of the
  // information. Two cuts that are wrong by *different* amounts say different
  // things and both survive.
  const byVariation = new Map<number, Map<string, string>>();
  for (const issue of flattenIssues(error.issues)) {
    // `superRefine` paths are ['variations', n, ...]; anything else (a missing
    // wrapper, a union failure) is grouped under -1 and sorts first, which is
    // right — a whole-response problem outranks a per-variation one.
    const variation =
      issue.path[0] === 'variations' && typeof issue.path[1] === 'number' ? issue.path[1] : -1;
    const location = issue.path.length > 0 ? issue.path.join('.') : 'response';
    const message = issue.message.replace(/\s+/g, ' ').trim();
    const lines = byVariation.get(variation) ?? new Map<string, string>();
    if (!lines.has(message)) lines.set(message, `${location}: ${message}`);
    byVariation.set(variation, lines);
  }

  const queues = [...byVariation.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, lines]) => [...lines.values()]);
  const ordered: string[] = [];
  for (let round = 0; queues.some((queue) => queue.length > round); round++) {
    for (const queue of queues) if (queue.length > round) ordered.push(queue[round]);
  }
  if (ordered.length === 0) return describeCause(error, maxLength);

  // Reserve room for the tail so the stated cap is the real one.
  const budget = ordered.length > 1 ? maxLength - CORRECTION_NOTE_TAIL_BUDGET : maxLength;
  const chosen: string[] = [];
  let used = 0;
  for (const line of ordered) {
    const cost = chosen.length === 0 ? line.length : line.length + CORRECTION_NOTE_SEPARATOR.length;
    if (used + cost > budget) break;
    chosen.push(line);
    used += cost;
  }
  // A single issue longer than the whole budget still has to say something.
  if (chosen.length === 0) return describeCause(new Error(ordered[0]), maxLength);

  const note = chosen.join(CORRECTION_NOTE_SEPARATOR);
  const omitted = ordered.length - chosen.length;
  return omitted > 0 ? `${note} (and ${omitted} more problems)` : note;
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
    pacingLabel,
    pacingBand,
    taggedPool,
    orderPatterns,
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
              `total duration ${round2(totalSeconds)}s wastes the available footage: this job ` +
              `only has ${round2(footage.availableSeconds)}s of distinct footage, so aim for ` +
              `about ${round2(footage.maxAchievableSeconds)}s rather than the ` +
              `${targetLengthSeconds}s target`,
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

      // The running order this variation was assigned. Enforced as well as
      // asked for, because it is the whole of what `variesClipOrder` buys: a
      // batch in which the model quietly used one structure five times is the
      // defect the flag exists to prevent, and nothing else in this validator
      // looks at the *order* of a variation's cuts.
      //
      // Only the two constrained patterns are checked; 'mixed' is by definition
      // satisfied. The test is one-sided — a variation is at fault only when a
      // "second" cut appears before a later "first" cut — so a variation that
      // uses just one of the two tags always passes, which is right: there is
      // no ordering to get wrong.
      if (orderPatterns) {
        const pattern = orderPatterns[variationIndex];
        if (pattern && pattern !== 'mixed') {
          const requiredFirst = pattern === 'broll-first' ? 'b-roll' : 'try-on';
          const requiredSecond = pattern === 'broll-first' ? 'try-on' : 'b-roll';
          const tags = variation.segments.map((cut) => cutContentTag(cut, taggedPool));
          const lastFirstIndex = tags.lastIndexOf(requiredFirst);
          const firstSecondIndex = tags.indexOf(requiredSecond);
          if (lastFirstIndex !== -1 && firstSecondIndex !== -1 && firstSecondIndex < lastFirstIndex) {
            ctx.addIssue({
              code: 'custom',
              path: [...variationPath, 'segments'],
              message:
                `this style's variation ${variationIndex + 1} must place every "${requiredFirst}" ` +
                `segment before every "${requiredSecond}" segment, but a "${requiredSecond}" segment ` +
                `appears before a later "${requiredFirst}" segment`,
            });
          }
        }
      }

      // The hook is burned onto the video exactly like the overlay is, so the
      // same rule has to apply to it. "I'm 5'6" and 140lb and this fits
      // perfectly" is a completely natural UGC hook for a model to write, and
      // it is precisely the harm the overlay guard exists to prevent: invented
      // body stats on a real creator's published video. Unlike the overlay
      // check this is unconditional — the hook is rendered whether or not the
      // job enabled the sizing overlay.
      if (FABRICATED_MEASUREMENT.test(variation.hookText)) {
        ctx.addIssue({
          code: 'custom',
          path: [...variationPath, 'hookText'],
          message:
            'hookText must not contain any height, weight or size measurement: you do not know ' +
            "the creator's real numbers and inventing them is not acceptable. Rewrite the hook " +
            'without any figures',
        });
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
              `this cut is ${round2(duration)}s long, but ${pacingLabel} means every cut must ` +
              `be between ${round2(pacingBand.min)}s and ${round2(pacingBand.max)}s. Split this ` +
              `footage into shorter cuts and place them at different points in the video instead ` +
              `of using it as one long take`,
          });
        } else if (floorApplies && duration < floor - 1e-9) {
          ctx.addIssue({
            code: 'custom',
            path,
            message:
              `this cut is only ${round2(duration)}s long, but ${pacingLabel} means every cut ` +
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
      // Neighbour-only comparison is cheap and catches the observed defect, but
      // it is trivially satisfiable by an alternating chain: ABAB, BABA, ABAB,
      // BABA, ABAB has every neighbouring pair differing in every position
      // while the creator receives three identical videos and two identical
      // videos. An exact-duplicate check across *all* pairs closes that without
      // the O(n^2) difficulty of a full all-pairs similarity rule: it costs one
      // string per variation and can only ever reject sequences that are
      // literally the same edit.
      const firstUseOfSequence = new Map<string, number>();
      value.variations.forEach((variation, index) => {
        const sequence = variation.segments
          .map((cut) => `${cut.rawClipId}|${cut.startSeconds}|${cut.endSeconds}`)
          .join(',');
        const original = firstUseOfSequence.get(sequence);
        if (original === undefined) {
          firstUseOfSequence.set(sequence, index);
          return;
        }
        ctx.addIssue({
          code: 'custom',
          path: ['variations', index, 'segments'],
          message:
            `this variation uses exactly the same cut sequence as variation ${original + 1}, so ` +
            `the creator would receive two identical videos with different hook text. Every ` +
            `variation must be a different edit from every other one, not just from the one ` +
            `before it: change the order, the subdivision boundaries and which moments are used`,
        });
      });

      /*
       * No byte-identical cut may appear in two different variations.
       *
       * Stricter than the sequence rule above, which only catches a wholly
       * duplicated edit. Per creator direction: an exact clip -- same source,
       * same start, same end, therefore the same frames -- must never be reused
       * across variations. Two videos sharing a literal cut are two videos
       * sharing a stretch of identical frames, which is what a platform's
       * duplicate detection fingerprints.
       *
       * Exact identity, not overlap: shifting a cut's boundaries produces
       * genuinely different frames at both ends, which is a real edit decision
       * and the cheapest way for the model to comply. Within one variation,
       * reuse stays governed by MAX_SEGMENT_REUSE.
       */
      const firstUseOfCut = new Map<string, number>();
      value.variations.forEach((variation, index) => {
        variation.segments.forEach((cut, cutIndex) => {
          const key = segmentKey(cut);
          const original = firstUseOfCut.get(key);
          if (original === undefined) {
            firstUseOfCut.set(key, index);
            return;
          }
          if (original === index) return; // same variation: MAX_SEGMENT_REUSE owns this
          ctx.addIssue({
            code: 'custom',
            path: ['variations', index, 'segments', cutIndex],
            message:
              `this cut (${round2(cut.startSeconds)}-${round2(cut.endSeconds)}s of the same clip) ` +
              `is byte-identical to one in variation ${original + 1}. No two variations may reuse ` +
              `the exact same frames — move this cut to a different part of the footage, or shift ` +
              `its start and end so it shows a different moment`,
          });
        });
      });

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
 * measurements and the size they recorded for this job, one per line: the
 * height on its own (e.g. "5'10\""), the weight on its own (e.g. "170 lbs"),
 * then "Size" plus the size worn (e.g. "Size M") — never a number the model
 * supplied. Returns null when there is nothing truthful to show, so a job
 * with an unfilled profile degrades to no overlay rather than a broken or
 * invented one.
 */
function buildSizingOverlayText(creator: Creator, job: Job): string | null {
  const lines = [
    creator.height?.trim() || null,
    creator.weight?.trim() || null,
    job.sizeWorn?.trim() ? `Size ${job.sizeWorn.trim()}` : null,
  ].filter((line): line is string => Boolean(line));

  if (lines.length === 0) return null;

  return lines.join('\n');
}

function buildPrompt(
  job: Job,
  segmentPool: PoolSegment[],
  footage: PoolCapacity,
  band: PacingBand,
  preset: EffectivePreset,
  orderPatterns: OrderPattern[] | null,
  correctionNote?: string
): string {
  const placements = OVERLAY_PLACEMENTS.map((p) => `"${p}"`).join(', ');
  const sizingInstruction = job.sizingOverlayEnabled
    ? `This ad shows a sizing overlay. Its text is built automatically from the creator's stored profile and the size worn${
        job.sizeWorn ? ` (size worn: ${job.sizeWorn})` : ''
      } as one line each for Height / Weight / Size - you never write any part of it. Always set sizingOverlayText to null. ${
        preset.sizingPlacementOverride
          ? `Set sizingOverlayPlacement to "${preset.sizingPlacementOverride}" for every variation - this style always places it there.`
          : `Set sizingOverlayPlacement to one of: ${placements}.`
      }`
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
    : `There is only ${round2(footage.availableSeconds)}s of distinct footage in the pool, which cannot fill the
${job.lengthSeconds}s target within the reuse limit below. Do NOT pad the video by repeating segments.
Aim instead for a total of about ${round2(footage.maxAchievableSeconds)}s per variation - a shorter video is
much better than a repetitive one.`;

  // Pacing is the product: constant clip changes are what makes this read as a
  // UGC ad rather than a home video. It is stated as hard numbers, and the same
  // band is enforced in code, so the instruction and the validator agree.
  const approximateCuts = Math.max(
    2,
    Math.round(job.lengthSeconds / ((preset.ideal.min + preset.ideal.max) / 2))
  );
  const pacingInstruction = `PACING IS THE MOST IMPORTANT RULE. ${preset.label} means every single cut
must last between ${round2(band.min)} and ${round2(band.max)} seconds, ideally around ${preset.ideal.min}-${preset.ideal.max} seconds.
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

  // Stated as well as enforced. The validator can only reject a wrong running
  // order after the fact, and each rejection costs one of three attempts, so the
  // per-variation assignment is spelled out here — derived from the same
  // `orderPatterns` array the validator checks against, so the two cannot drift.
  const orderingInstruction = orderPatterns
    ? `CLIP ORDER VARIES BY VARIATION. This style alternates the order footage appears in across variations.
For each variation (1-indexed, matching its position in your response array), follow this rule:
${orderPatterns.map((pattern, i) => `- Variation ${i + 1}: ${orderingRuleText(pattern)}`).join('\n')}
Segments tagged "b-roll" or "try-on" are the ones this rule constrains; segments tagged "whole-clip" or "other" may appear anywhere.`
    : '';

  /*
   * Fit Inspo spends its first four seconds with reference images stacked over
   * the footage and the hook on top, so whatever is playing underneath is
   * barely visible. Telling the model this stops it spending the best shot
   * there — the opening cut is background, and the payoff belongs after it.
   */
  const introInstruction = preset.opensOnIntro
    ? `
THIS STYLE OPENS ON AN INTRO. For the first ${FIT_INSPO_INTRO_SECONDS} seconds the frame is ` +
      `covered by reference images and the hook, so the footage underneath is mostly hidden. Open on ` +
      `an ordinary establishing moment, never the best one, and put the strongest footage after the ` +
      `${FIT_INSPO_INTRO_SECONDS}s mark where it can actually be seen.
`
    : '';

  return `You are editing a short-form UGC ad video for the product "${job.productName}".
Target length: ${job.lengthSeconds} seconds. Editing style: ${preset.label}.
Produce exactly ${job.variationCount} distinct variations.
${introInstruction}

Available segments (choose from these only, by rawClipId):
${JSON.stringify(segmentPool)}

${pacingInstruction}

${visibleCutInstruction}

${durationInstruction}
${distinctnessInstruction}
${orderingInstruction}
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
${JSON.stringify(preset.hookStyleLibrary)}
Write hookText as ONE short on-screen line, under ${MAX_HOOK_LENGTH} characters. It must never contain a
height, weight or size measurement - you do not know the creator's real numbers, and inventing them
would print made-up body stats on a real person's published video.
If the hook names the product at all, use the SHORTEST natural word for it, normally one word - the
product is "${job.productName}", so write something like "${shortProductNoun(job.productName)}". Never
write the full product name into a hook: these are captions someone speaks over, and a full retail
title reads like an ad instead of a person talking.

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

    // Style mode: the whole editing recipe (cut band, hook library, pinned
    // sizing corner) comes from this row instead of a named pacing preset. A
    // dangling or malformed style is a hard failure rather than a silent
    // fallback to `pacing` — the job asked for a specific look, and quietly
    // giving it a different one would be worse than telling the creator.
    const style = job.styleId
      ? (await db.select().from(styles).where(eq(styles.id, job.styleId)))[0]
      : undefined;
    if (job.styleId && !style) {
      return { success: false, error: `Style ${job.styleId} referenced by job ${jobId} was not found` };
    }
    // The validated config, not the raw JSONB row, is what gets threaded into
    // `resolvePreset` below — nothing downstream may re-cast `style.config`.
    let resolvedStyle: { name: string; config: StyleConfig } | undefined;
    if (style) {
      const parsedConfig = StyleConfigSchema.safeParse(style.config);
      if (!parsedConfig.success) {
        return {
          success: false,
          error: `Style ${style.id} has an invalid config: ${parsedConfig.error.message}`,
        };
      }
      resolvedStyle = { name: style.name, config: parsedConfig.data };
    }

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

    // The per-cut length the job's preset asks for, used to build the prompt,
    // to validate the response, and to judge what the pool can reach.
    // The creator's audience picks the register of the hook, not its topic.
    const preset = resolvePreset(job, resolvedStyle, creator.audience);
    const band = bandForPreset(preset.ideal);

    // Established before the model is asked for anything: whether the creator's
    // upload can honestly fill the length they asked for.
    const footage = measurePool(segmentPool, job.lengthSeconds, band);

    // A style that varies its clip order can only do so when the shoot actually
    // has both halves. With only b-roll (or only try-on) tagged, "b-roll before
    // try-on" and its mirror describe the same single sequence, so asking for
    // them would add prompt noise and a rule that can never bite. Left null in
    // that case, which switches the whole mechanism off.
    const hasBothOrderingTags =
      segmentPool.some((s) => s.contentTag === 'b-roll') &&
      segmentPool.some((s) => s.contentTag === 'try-on');
    const orderPatterns =
      preset.variesClipOrder && hasBothOrderingTags
        ? orderPatternsForVariations(job.variationCount)
        : null;

    const validator = buildValidator({
      expectedVariationCount: job.variationCount,
      targetLengthSeconds: job.lengthSeconds,
      footageEndByClipId,
      sizingOverlayEnabled: job.sizingOverlayEnabled,
      footage,
      pacingLabel: preset.label,
      pacingBand: band,
      taggedPool: segmentPool,
      orderPatterns,
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
                parts: [
                  {
                    text: buildPrompt(
                      job,
                      segmentPool,
                      footage,
                      band,
                      preset,
                      orderPatterns,
                      correctionNote
                    ),
                  },
                ],
              },
            ],
            config: { responseMimeType: 'application/json' },
          }),
        DIRECTOR_RETRY
      );

      // A response the model never got to finish is not a wrong answer, and
      // must not be treated as one. Without this, hitting the output-token
      // limit surfaces as `JSON.parse`'s "Unexpected end of JSON input", which
      // becomes a correction note telling the model to fix a shape problem it
      // never had — three times, ending in a misleading failure reason. Bailing
      // out with the real reason is the only honest answer: re-asking the same
      // question would truncate at exactly the same place.
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== FinishReason.STOP) {
        return {
          success: false,
          error:
            finishReason === FinishReason.MAX_TOKENS
              ? 'Gemini ran out of output tokens before it finished the edit plan ' +
                '(finishReason MAX_TOKENS). Ask for fewer variations, a shorter video, or a ' +
                'slower pacing preset, or raise the model\'s output token limit.'
              : `Gemini stopped before finishing the edit plan (finishReason ${finishReason})`,
        };
      }

      try {
        parsed = validator.parse(JSON.parse(response.text ?? ''));
        break;
      } catch (validationError) {
        // Feed the specific reasons back into the next attempt: a blind re-roll
        // would very likely repeat the same mistake.
        lastFailure = validationError;
        correctionNote = summarizeIssues(validationError, MAX_CORRECTION_NOTE_LENGTH);
        parsed = undefined;
      }
    }

    if (!parsed) {
      return {
        success: false,
        // Summarised the same way as the correction note, so the stored reason
        // names the rules that were actually broken rather than an excerpt of
        // Zod's JSON blob.
        error: `Gemini did not produce a valid edit plan after ${MAX_ATTEMPTS} attempts: ${summarizeIssues(
          lastFailure,
          MAX_CAUSE_LENGTH
        )}`,
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
            ? buildSizingOverlayText(creator, job)
            : null;

          return {
            jobId,
            variationNumber: index + 1,
            segments: v.segments,
            hookText: v.hookText,
            sizingOverlayText: overlayText,
            // A placement without a caption would render an empty overlay. A
            // style that pins one corner wins over whatever the model returned:
            // the pin is part of the style's identity, not a suggestion.
            sizingOverlayPlacement: overlayText
              ? preset.sizingPlacementOverride ?? v.sizingOverlayPlacement
              : null,
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
