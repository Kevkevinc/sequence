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
  let creatorId: string;

  /**
   * Removes every row this file created on a previous run. Child rows go first
   * because raw_clips/edit_plans reference jobs and segments reference raw_clips.
   */
  async function cleanUpCreatorJobs() {
    const ownJobs = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.creatorId, creatorId));
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

  beforeEach(async () => {
    vi.clearAllMocks();
    const creator = await createCreatorIfNotExists(CLERK_ID);
    creatorId = creator.id;
    await cleanUpCreatorJobs();
  });

  afterEach(async () => {
    await cleanUpCreatorJobs();
    const stillThere = await db.query.creators.findFirst({ where: eq(creators.clerkUserId, CLERK_ID) });
    if (stillThere) await db.delete(creators).where(eq(creators.id, stillThere.id));
  });

  it('claims a pending job and moves it to tagging', async () => {
    await makeJob();

    // The queue is global, so record which jobs were actually claimable before
    // claiming: the claim must return one of those, not an arbitrary row.
    const pendingBefore = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, 'pending'));
    const pendingIds = pendingBefore.map((j) => j.id);

    const claimed = await claimNextPendingJob();

    expect(claimed?.id).toBeDefined();
    expect(pendingIds).toContain(claimed!.id);

    const updated = await statusOf(claimed!.id);
    expect(updated.status).toBe('tagging');
  });

  it('never hands the same job to two concurrent workers', async () => {
    // More concurrent claimers than jobs, so several must come back empty
    // rather than double-claiming: this is the check a plain
    // "select ... limit 1" subquery (no row lock) fails under READ COMMITTED.
    const CLAIMERS = 6;
    await Promise.all([makeJob(), makeJob(), makeJob(), makeJob()]);

    const claims = await Promise.all(Array.from({ length: CLAIMERS }, () => claimNextPendingJob()));
    const claimedIds = claims.filter((c): c is { id: string } => c !== undefined).map((c) => c.id);

    // Uniqueness alone passes vacuously if nothing is claimed at all, which an
    // implementation that skipped or blocked too eagerly (e.g. `noWait`) would
    // do. At least the four seeded jobs must actually be handed out: a lock
    // loser retries against the remaining rows rather than giving up.
    expect(claimedIds.length).toBeGreaterThanOrEqual(4);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);

    // Every claimed job must have actually landed in `tagging`.
    const claimedRows = await db.select().from(jobs).where(inArray(jobs.id, claimedIds));
    expect(claimedRows.every((r) => r.status === 'tagging')).toBe(true);
  });

  it('processes a job end to end: tags all clips, plans it, marks planned', async () => {
    const job = await makeJob();
    vi.mocked(tagClip).mockResolvedValue({ success: true, segmentCount: 1 });
    vi.mocked(planJob).mockResolvedValue({ success: true, variationCount: 1 });

    await processJob(job.id);

    expect(tagClip).toHaveBeenCalledTimes(1);
    expect(planJob).toHaveBeenCalledWith(job.id);

    const updated = await statusOf(job.id);
    expect(updated.status).toBe('planned');
    expect(updated.failureReason).toBeNull();
  });

  it('continues with the clips that tagged successfully when only some fail', async () => {
    const job = await makeJob(2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(tagClip)
      .mockResolvedValueOnce({ success: false, error: 'clip unreadable' })
      .mockResolvedValueOnce({ success: true, segmentCount: 3 });
    vi.mocked(planJob).mockResolvedValue({ success: true, variationCount: 1 });

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
      return { success: true, variationCount: 1 };
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
