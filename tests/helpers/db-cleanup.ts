import { eq, inArray, like } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators, jobs, rawClips, segments, editPlans, renders, jobInspirationImages, styles } from '@/db/schema';

/**
 * Deletes every job a creator owns, and everything those jobs reference.
 *
 * Every test file that creates a job under a fixed, reused `clerk_user_id`
 * must call this in an `afterEach` (or equivalent), or every run against the
 * shared dev database leaves that run's jobs behind permanently — this is
 * what generated hundreds of orphaned rows in practice. Child rows go first
 * because raw_clips/edit_plans/job_inspiration_images reference jobs and
 * segments reference raw_clips.
 */
export async function cleanUpCreatorJobs(creatorId: string): Promise<void> {
  const ownJobs = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.creatorId, creatorId));
  if (ownJobs.length === 0) return;
  const jobIds = ownJobs.map((j) => j.id);

  const clips = await db.select({ id: rawClips.id }).from(rawClips).where(inArray(rawClips.jobId, jobIds));
  if (clips.length > 0) {
    await db.delete(segments).where(inArray(segments.rawClipId, clips.map((c) => c.id)));
  }
  await db.delete(renders).where(inArray(renders.jobId, jobIds));
  await db.delete(editPlans).where(inArray(editPlans.jobId, jobIds));
  await db.delete(jobInspirationImages).where(inArray(jobInspirationImages.jobId, jobIds));
  await db.delete(rawClips).where(inArray(rawClips.jobId, jobIds));
  await db.delete(jobs).where(inArray(jobs.id, jobIds));
}

/** Same cleanup, looked up by the fixed `clerk_user_id` a test file reuses across runs. */
export async function cleanUpJobsForClerkId(clerkUserId: string): Promise<void> {
  const creator = await db.query.creators.findFirst({ where: eq(creators.clerkUserId, clerkUserId) });
  if (!creator) return;
  await cleanUpCreatorJobs(creator.id);
}

/**
 * Deletes throwaway styles created inline by a test (rather than through
 * `seedBuiltInStyles`). Every such style in this codebase is named with a
 * `Test ` prefix specifically so this sweep can find it; a name that doesn't
 * start with `Test ` is never touched.
 */
export async function deleteTestStyles(): Promise<void> {
  await db.delete(styles).where(like(styles.name, 'Test %'));
}
