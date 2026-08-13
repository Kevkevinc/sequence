/**
 * How a job is described on screen.
 *
 * The API speaks the pipeline's language (seven statuses, one per stage the
 * worker walks). The interface speaks the creator's: is it working, is it done,
 * did some of it not make it, did it fail. This module is the single place the
 * two are reconciled, so a card, a filter and a detail header can never
 * disagree about what a job is.
 */

/** Every status the API can return, in pipeline order. */
export type JobStatus =
  | 'pending'
  | 'tagging'
  | 'planning'
  | 'planned'
  | 'rendering'
  | 'done'
  | 'failed';

export type VariationStatus = 'pending' | 'rendering' | 'done' | 'failed';

/** The four states the interface actually shows. */
export type DisplayStatus = 'working' | 'done' | 'partial' | 'failed';

export type JobSummary = {
  id: string;
  productName: string;
  status: JobStatus;
  lengthSeconds: number;
  pacing: 'slow' | 'medium' | 'fast' | null;
  styleName?: string | null;
  variationCount: number;
  kind: 'cuts' | 'talking';
  /** Renders that finished, and renders that failed. Supplied by /api/jobs. */
  doneCount: number;
  failedCount: number;
  /** A real frame from the first finished render; null until one exists. */
  thumbnailUrl?: string | null;
  createdAt: string;
};

/** One finished, pending or failed video, as the detail route reports it. */
export type Variation = {
  variationNumber: number;
  hookText: string;
  status: VariationStatus;
  durationSeconds: number | null;
  playbackUrl: string | null;
  downloadUrl: string | null;
  thumbnailUrl: string | null;
  failureReason: string | null;
};

export type JobDetail = {
  id: string;
  productName: string;
  status: JobStatus;
  kind: 'cuts' | 'talking';
  lengthSeconds: number;
  pacing: 'slow' | 'medium' | 'fast' | null;
  styleName: string | null;
  variationCount: number;
  /** Drives the time estimate: tagging is one model call per clip. */
  clipCount: number;
  warning: string | null;
  failureReason: string | null;
  createdAt: string;
  variations: Variation[];
};

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  working: 'Working',
  done: 'Done',
  partial: 'Partly done',
  failed: 'Failed',
};

/**
 * A job's state in the creator's terms.
 *
 * A finished job that produced nothing is a failure, however the pipeline
 * recorded it: "Done, 0 videos" would be the single most confusing thing this
 * screen could say.
 */
export function displayStatus(job: {
  status: JobStatus;
  variationCount: number;
  doneCount: number;
}): DisplayStatus {
  if (job.status === 'failed') return 'failed';
  if (job.status !== 'done') return 'working';
  if (job.doneCount === 0) return 'failed';
  return job.doneCount >= job.variationCount ? 'done' : 'partial';
}

/** True while the job could still change without a reload. */
export function isRunning(status: JobStatus) {
  return status !== 'done' && status !== 'failed';
}

const GRADES = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
export type Grade = (typeof GRADES)[number];

/**
 * One of the six duotone grades, so a list never reads as the same grey clip
 * repeated. Keyed off the job id rather than its position, so a card does not
 * change colour when a newer job pushes it down the list.
 */
export function gradeFor(seed: string | number): Grade {
  if (typeof seed === 'number') return GRADES[Math.abs(seed) % GRADES.length];
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 997;
  }
  return GRADES[hash % GRADES.length];
}

/** "4 of 10 ready · 30s", or "6 videos · 30s" once there is nothing pending. */
export function countLine(job: JobSummary): string {
  const display = displayStatus(job);
  const length = `${job.lengthSeconds}s`;

  if (display === 'working') return `${job.doneCount} of ${job.variationCount} ready · ${length}`;
  if (display === 'failed') return `No videos · ${length}`;
  const count = job.doneCount;
  return `${count} video${count === 1 ? '' : 's'} · ${length}`;
}

/** "Fast pacing · silent cuts", or "Talking to camera". */
export function styleLine(job: JobSummary): string {
  if (job.kind === 'talking') return 'Talking to camera';
  const how = job.styleName ?? `${capitalise(job.pacing ?? 'custom')} pacing`;
  return `${how} · silent cuts`;
}

function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Percent of this job's videos that have finished. Drives the progress line on
 * the Running now card and how many tick bars are filled.
 */
export function percentComplete(job: { doneCount: number; variationCount: number }): number {
  if (job.variationCount <= 0) return 0;
  return Math.round((job.doneCount / job.variationCount) * 100);
}
