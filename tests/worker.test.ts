import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

vi.mock('@/lib/pipeline/tagging', () => ({ tagClip: vi.fn() }));
vi.mock('@/lib/pipeline/director', () => ({ planJob: vi.fn() }));

import { db } from '@/db/client';
import { creators, jobs, rawClips, segments, editPlans } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { tagClip } from '@/lib/pipeline/tagging';
import { planJob } from '@/lib/pipeline/director';
import { claimNextPendingJob, processJob } from '@/worker';

describe('worker', () => {
  const CLERK_ID = 'test_clerk_user_worker';
  // A second throwaway creator, used to prove the claim stays inside its scope.
  const OTHER_CLERK_ID = 'test_clerk_user_worker_other';
  let creatorId: string;
  let otherCreatorId: string | undefined;

  /**
   * Removes every row this file created on a previous run. Child rows go first
   * because raw_clips/edit_plans reference jobs and segments reference raw_clips.
   */
  async function cleanUpCreatorJobs(ownerId: string) {
    const ownJobs = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.creatorId, ownerId));
    if (ownJobs.length === 0) return;
    const jobIds = ownJobs.map((j) => j.id);

    const clips = await db.select({ id: rawClips.id }).from(rawClips).where(inArray(rawClips.jobId, jobIds));
    if (clips.length > 0) {
      await db.delete(segments).where(inArray(segments.rawClipId, clips.map((c) => c.id)));
    }
    await db.delete(editPlans).where(inArray(editPlans.jobId, jobIds));
    await db.delete(rawClips).where(inArray(rawClips.jobId, jobIds));
    await db.delete(jobs).where(inArray(jobs.id, jobIds));
  }

  async function makeJob(clipCount = 1) {
    return createJob({
      creatorId,
      productName: 'Worker Test Product',
      sizingOverlayEnabled: false,
      lengthSeconds: 15,
      pacing: 'fast',
      variationCount: 1,
      clips: Array.from({ length: clipCount }, (_, i) => ({
        storageKey: `clips/w${i}.mp4`,
        originalFilename: `w${i}.mp4`,
      })),
    });
  }

  async function statusOf(jobId: string) {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    return row;
  }

  /** Deletes a throwaway creator and everything it owns, if it still exists. */
  async function removeCreator(clerkUserId: string) {
    const stillThere = await db.query.creators.findFirst({
      where: eq(creators.clerkUserId, clerkUserId),
    });
    if (!stillThere) return;
    await cleanUpCreatorJobs(stillThere.id);
    await db.delete(creators).where(eq(creators.id, stillThere.id));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const creator = await createCreatorIfNotExists(CLERK_ID);
    creatorId = creator.id;
    otherCreatorId = undefined;
    await cleanUpCreatorJobs(creatorId);
    // A leftover foreign job from an interrupted run would otherwise sit
    // `pending` forever and confuse the scoping test.
    await removeCreator(OTHER_CLERK_ID);
  });

  afterEach(async () => {
    await cleanUpCreatorJobs(creatorId);
    await removeCreator(CLERK_ID);
    if (otherCreatorId) await removeCreator(OTHER_CLERK_ID);
  });

  /**
   * Claims only from this file's throwaway creator.
   *
   * These tests run against the shared dev database, where an unscoped claim is
   * indistinguishable from the worker's and once grabbed a real creator's job,
   * stranding it in `tagging` with nothing to move it on. Scoping is a filter
   * on the same statement — the ordering and the `FOR UPDATE SKIP LOCKED` claim
   * are untouched, so what is under test is still exactly production's claim.
   */
  function claimOwnJob() {
    return claimNextPendingJob({ restrictToCreatorId: creatorId });
  }

  it('claims a pending job and moves it to tagging', async () => {
    const job = await makeJob();

    const claimed = await claimOwnJob();

    // Exact, not "one of the pending rows": the claim must never reach outside
    // the jobs this test seeded.
    expect(claimed?.id).toBe(job.id);

    const updated = await statusOf(claimed!.id);
    expect(updated.status).toBe('tagging');
  });

  it('never claims a job belonging to someone else', async () => {
    // The guard that makes the rest of this file safe on a shared database.
    const other = await createCreatorIfNotExists(OTHER_CLERK_ID);
    otherCreatorId = other.id;
    const foreignJob = await createJob({
      creatorId: other.id,
      productName: 'Someone Else Product',
      sizingOverlayEnabled: false,
      lengthSeconds: 15,
      pacing: 'fast',
      variationCount: 1,
      clips: [{ storageKey: 'clips/other.mp4', originalFilename: 'other.mp4' }],
    });

    const claimed = await claimOwnJob();

    expect(claimed).toBeUndefined();
    const untouched = await statusOf(foreignJob.id);
    expect(untouched.status).toBe('pending');
  });

  it('never hands the same job to two concurrent workers', async () => {
    // More concurrent claimers than jobs, so several must come back empty
    // rather than double-claiming: this is the check a plain
    // "select ... limit 1" subquery (no row lock) fails under READ COMMITTED.
    const CLAIMERS = 6;
    const seeded = await Promise.all([makeJob(), makeJob(), makeJob(), makeJob()]);
    const seededIds = new Set(seeded.map((j) => j.id));

    const claims = await Promise.all(Array.from({ length: CLAIMERS }, () => claimOwnJob()));
    const claimedIds = claims.filter((c): c is { id: string } => c !== undefined).map((c) => c.id);

    // Uniqueness alone passes vacuously if nothing is claimed at all, which an
    // implementation that skipped or blocked too eagerly (e.g. `noWait`) would
    // do. At least the four seeded jobs must actually be handed out: a lock
    // loser retries against the remaining rows rather than giving up.
    expect(claimedIds.length).toBeGreaterThanOrEqual(4);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds.every((id) => seededIds.has(id))).toBe(true);

    // Every claimed job must have actually landed in `tagging`.
    const claimedRows = await db.select().from(jobs).where(inArray(jobs.id, claimedIds));
    expect(claimedRows.every((r) => r.status === 'tagging')).toBe(true);
  });

  it('processes a job end to end: tags all clips, plans it, marks planned', async () => {
    const job = await makeJob();
    vi.mocked(tagClip).mockResolvedValue({ success: true, segmentCount: 1 });
    vi.mocked(planJob).mockResolvedValue({ success: true, variationCount: 1, warning: null });

    await processJob(job.id);

    expect(tagClip).toHaveBeenCalledTimes(1);
    expect(planJob).toHaveBeenCalledWith(job.id);

    const updated = await statusOf(job.id);
    expect(updated.status).toBe('planned');
    expect(updated.failureReason).toBeNull();
  });

  it('logs the planner warning but still marks a short-footage job planned', async () => {
    const job = await makeJob();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(tagClip).mockResolvedValue({ success: true, segmentCount: 1 });
    vi.mocked(planJob).mockResolvedValue({
      success: true,
      variationCount: 1,
      warning: 'Only 7s of usable footage was available',
    });

    await processJob(job.id);

    // A short video is a usable result: this must not become a failure.
    const updated = await statusOf(job.id);
    expect(updated.status).toBe('planned');
    expect(warn.mock.calls.flat().join(' ')).toContain('Only 7s of usable footage');
    warn.mockRestore();
  });

  it('continues with the clips that tagged successfully when only some fail', async () => {
    const job = await makeJob(2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(tagClip)
      .mockResolvedValueOnce({ success: false, error: 'clip unreadable' })
      .mockResolvedValueOnce({ success: true, segmentCount: 3 });
    vi.mocked(planJob).mockResolvedValue({ success: true, variationCount: 1, warning: null });

    await processJob(job.id);

    expect(tagClip).toHaveBeenCalledTimes(2);
    expect(planJob).toHaveBeenCalledWith(job.id);

    const updated = await statusOf(job.id);
    expect(updated.status).toBe('planned');

    // The job row stays clean, so the dropped clip must at least be logged:
    // otherwise the creator gets an edit cut from less footage with no trace why.
    const droppedClipId = vi.mocked(tagClip).mock.calls[0][0];
    expect(warn).toHaveBeenCalledTimes(1);
    const warned = warn.mock.calls[0].join(' ');
    expect(warned).toContain(droppedClipId);
    expect(warned).toContain('clip unreadable');
    warn.mockRestore();
  });

  it('tags clips with a bounded concurrency instead of fanning out over all of them', async () => {
    // Unbounded `Promise.all(clips.map(...))` put every clip's video through
    // the machine at once. At 100-200MB of raw phone footage per clip that is
    // enough to be OOM-killed, which strands the job in `tagging` forever
    // because nothing reaps it — and it fires N simultaneous Gemini uploads,
    // manufacturing the 429s the retry layer then absorbs.
    const CLIP_COUNT = 6;
    const job = await makeJob(CLIP_COUNT);
    let inFlight = 0;
    let peakInFlight = 0;
    vi.mocked(tagClip).mockImplementation(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { success: true, segmentCount: 1 };
    });
    vi.mocked(planJob).mockResolvedValue({ success: true, variationCount: 1, warning: null });

    await processJob(job.id);

    // Every clip is still tagged...
    expect(tagClip).toHaveBeenCalledTimes(CLIP_COUNT);
    // ...but never more than a couple at a time, and still with real overlap
    // (a serial implementation would peak at 1 and lose the pipelining).
    expect(peakInFlight).toBeLessThanOrEqual(3);
    expect(peakInFlight).toBeGreaterThan(1);
    expect((await statusOf(job.id)).status).toBe('planned');
  });

  it('keeps tag results lined up with their clips despite the concurrency limit', async () => {
    // The failure report indexes `tagResults[i]` against `clips[i]`, so an
    // out-of-order result would blame the wrong clip in the failure reason.
    const job = await makeJob(4);
    const clips = await db
      .select({ id: rawClips.id })
      .from(rawClips)
      .where(eq(rawClips.jobId, job.id));
    // Fail only the clip that is processed third, with a distinctive reason.
    vi.mocked(tagClip).mockImplementation(async (clipId: string) =>
      clipId === clips[2].id
        ? { success: false, error: 'third clip unreadable' }
        : { success: true, segmentCount: 1 }
    );
    vi.mocked(planJob).mockResolvedValue({ success: true, variationCount: 1, warning: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await processJob(job.id);

    const warned = warn.mock.calls.flat().join(' ');
    expect(warned).toContain(clips[2].id);
    expect(warned).toContain('third clip unreadable');
    // No other clip may be named as failed.
    for (const other of [clips[0], clips[1], clips[3]]) {
      expect(warned).not.toContain(other.id);
    }
    warn.mockRestore();
  });

  it('marks the job failed with a reason when every clip fails tagging', async () => {
    const job = await makeJob();
    vi.mocked(tagClip).mockResolvedValue({ success: false, error: 'clip unreadable' });

    await processJob(job.id);

    expect(planJob).not.toHaveBeenCalled();

    const updated = await statusOf(job.id);
    expect(updated.status).toBe('failed');
    expect(updated.failureReason).toContain('clip unreadable');
  });

  it('marks the job failed with a reason when it has no clips at all', async () => {
    const job = await makeJob(0);

    await processJob(job.id);

    expect(tagClip).not.toHaveBeenCalled();
    expect(planJob).not.toHaveBeenCalled();

    const updated = await statusOf(job.id);
    expect(updated.status).toBe('failed');
    expect(updated.failureReason).toBeTruthy();
  });

  it('marks the job failed with a reason when planning fails', async () => {
    const job = await makeJob();
    vi.mocked(tagClip).mockResolvedValue({ success: true, segmentCount: 2 });
    vi.mocked(planJob).mockResolvedValue({ success: false, error: 'no valid plan' });

    await processJob(job.id);

    const updated = await statusOf(job.id);
    expect(updated.status).toBe('failed');
    expect(updated.failureReason).toContain('no valid plan');
  });

  it('moves the job to planning before handing it to the director', async () => {
    const job = await makeJob();
    vi.mocked(tagClip).mockResolvedValue({ success: true, segmentCount: 1 });
    let statusDuringPlanning: string | undefined;
    vi.mocked(planJob).mockImplementation(async () => {
      statusDuringPlanning = (await statusOf(job.id)).status;
      return { success: true, variationCount: 1, warning: null };
    });

    await processJob(job.id);

    expect(statusDuringPlanning).toBe('planning');
  });

  it('marks the job failed instead of leaving it stuck when something throws unexpectedly', async () => {
    const job = await makeJob();
    vi.mocked(tagClip).mockRejectedValue(new Error('gemini client blew up'));

    await expect(processJob(job.id)).resolves.toBeUndefined();

    const updated = await statusOf(job.id);
    expect(updated.status).toBe('failed');
    expect(updated.failureReason).toContain('gemini client blew up');
  });
});
