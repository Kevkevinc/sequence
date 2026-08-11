import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { reclaimOrphanedAnalysis } from '../worker';
import { cleanUpJobsForClerkId } from './helpers/db-cleanup';

const CLERK_ID = 'test_clerk_user_analysis_reaper';

/**
 * A job left in `tagging` or `planning` had no recovery path at all: a deploy
 * landing mid-analysis stranded it permanently, and one real job sat there for
 * an hour and three quarters.
 */
describe('reclaimOrphanedAnalysis', () => {
  let creatorId: string;

  beforeEach(async () => {
    creatorId = (await createCreatorIfNotExists(CLERK_ID)).id;
    await cleanUpJobsForClerkId(CLERK_ID);
  });

  afterAll(async () => {
    await cleanUpJobsForClerkId(CLERK_ID);
  });

  async function seed(status: 'tagging' | 'planning' | 'rendering' | 'done', attempts = 0) {
    const job = await createJob({
      creatorId,
      productName: `reaper ${status}`,
      sizingOverlayEnabled: false,
      lengthSeconds: 30,
      pacing: 'medium',
      variationCount: 1,
      clips: [{ storageKey: 'clips/x.mp4', originalFilename: 'x.mp4' }],
    });
    await db.update(jobs).set({ status, attempts }).where(eq(jobs.id, job.id));
    return job.id;
  }

  const statusOf = async (id: string) =>
    (await db.select().from(jobs).where(eq(jobs.id, id)))[0];

  it('requeues a job stranded in tagging or planning', async () => {
    const tagging = await seed('tagging');
    const planning = await seed('planning');

    await reclaimOrphanedAnalysis();

    expect((await statusOf(tagging)).status).toBe('pending');
    expect((await statusOf(planning)).status).toBe('pending');
    // Counted, so a job that strands repeatedly cannot cycle forever.
    expect((await statusOf(tagging)).attempts).toBe(1);
  });

  it('leaves jobs in other statuses alone', async () => {
    // `rendering` belongs to the render reaper; touching it here would fight it.
    const rendering = await seed('rendering');
    const done = await seed('done');

    await reclaimOrphanedAnalysis();

    expect((await statusOf(rendering)).status).toBe('rendering');
    expect((await statusOf(done)).status).toBe('done');
  });

  it('fails a job that has already been retried too often', async () => {
    const exhausted = await seed('tagging', 5);

    await reclaimOrphanedAnalysis();

    const job = await statusOf(exhausted);
    expect(job.status).toBe('failed');
    expect(job.failureReason).toMatch(/could not be analysed/i);
  });
});
