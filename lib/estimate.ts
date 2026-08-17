/**
 * How long a running job still has to go.
 *
 * Renders take ten to fifteen minutes, which is long enough that silence reads
 * as a crash. Every number here comes from timing real jobs on the render
 * machine: tagging dominates and scales per clip (each one is downloaded,
 * uploaded to Gemini and analysed), rendering is per variation.
 *
 * Deliberately coarse in the output. The real duration depends on footage size
 * and how busy the machine is, so this says "about 6 min left", never a
 * countdown it would have to walk back.
 */

import type { JobStatus } from '@/lib/jobView';

const TAGGING_SECONDS_PER_CLIP = 55;
const PLANNING_SECONDS = 12;
const RENDER_SECONDS_PER_VARIATION = 150;
/**
 * 4K renders take roughly five times as long per variation — measured, see
 * lib/render/frame.ts. Tagging and planning are unchanged: they analyse the
 * source clips, which are the same footage whatever the output resolution.
 */
const FOUR_K_RENDER_MULTIPLIER = 5;
/** Used where the clip count is not to hand, which is every list screen. */
const ASSUMED_CLIPS = 4;

export function estimateRemainingSeconds(
  job: {
    status: JobStatus;
    createdAt: string;
    variationCount: number;
    doneCount: number;
    clipCount?: number;
    quality?: '1080p' | '4k';
  },
  now: number
): number | null {
  if (job.status === 'done' || job.status === 'failed') return null;

  const elapsed = (now - new Date(job.createdAt).getTime()) / 1000;
  const remaining = Math.max(0, job.variationCount - job.doneCount);
  const renderPerVariation =
    RENDER_SECONDS_PER_VARIATION * (job.quality === '4k' ? FOUR_K_RENDER_MULTIPLIER : 1);

  /*
   * Once videos start landing, the measured pace of *this* job replaces the
   * constant, so a slow machine or unusually long clips stop being
   * systematically underestimated. Capped at three times the expected pace so
   * one stalled render does not project an absurd wait.
   */
  if (job.status === 'rendering' && job.doneCount > 0) {
    const perVariation = elapsed / job.doneCount;
    return Math.round(remaining * Math.min(perVariation, renderPerVariation * 3));
  }

  const clips = job.clipCount ?? ASSUMED_CLIPS;
  const aiTotal = clips * TAGGING_SECONDS_PER_CLIP + PLANNING_SECONDS;
  const aiRemaining =
    job.status === 'rendering' || job.status === 'planned' ? 0 : Math.max(0, aiTotal - elapsed);

  return Math.round(aiRemaining + remaining * renderPerVariation);
}

/** "about 6 min left". Coarse on purpose. */
export function formatRemaining(seconds: number): string {
  if (seconds < 45) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} min left`;
}
