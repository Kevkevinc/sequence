/**
 * The shared vocabulary of an EditPlan — the contract between the AI planning
 * stage and the rendering stage.
 *
 * These values are declared here, and only here, because both sides need them
 * and neither owns them: the director prompts for and validates against them,
 * the renderer draws them. They previously existed as two identical literals in
 * `lib/pipeline/director.ts` and `lib/render/text.ts` held together by nothing
 * but paired comments, and drift would have failed *silently* — an unrecognised
 * placement falls back to a corner rather than raising, so a mismatch would put
 * sizing text in the wrong place on a published video with no error anywhere.
 *
 * This module deliberately has no imports. Either side pulling in the other
 * would be worse than the duplication it replaces: importing the renderer into
 * the pipeline drags a native canvas binding into planning, and importing the
 * pipeline into the renderer inverts the dependency for no reason.
 */

/** Where a sizing overlay may be anchored. The only placements Stage 3 renders. */
export const OVERLAY_PLACEMENTS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

export type OverlayPlacement = (typeof OVERLAY_PLACEMENTS)[number];
