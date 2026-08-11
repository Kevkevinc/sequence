import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { apiUsage, creators, jobs, rawClips, segments, editPlans, renders, jobInspirationImages, styles } from '@/db/schema';

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
  // Metering rows too. They carry no foreign key (usage is a financial record
  // and must outlive the job it describes), so nothing would ever remove them
  // and a test run would permanently inflate the spend dashboard's call count.
  await db.delete(apiUsage).where(inArray(apiUsage.jobId, jobIds));
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
 * `seedBuiltInStyles`), matched by exact name.
 *
 * Callers must pass only the literal names *that file itself* creates —
 * never a shared prefix sweep. Vitest runs test files in parallel workers,
 * and a prefix sweep (originally `name LIKE 'Test %'`) reliably deleted
 * another file's in-flight style: one test's `INSERT styles` followed by
 * its own `INSERT jobs` referencing that style has a real gap in wall-clock
 * time, and a concurrent file's blanket sweep landing in that gap violates
 * `jobs_style_id_styles_id_fk`. Distinct literal names per file make that
 * impossible — no file's cleanup can ever name a row another file owns.
 *
 * Also excludes any style a job still references, as a second, unrelated
 * safety net (e.g. against a slow query within the same file). Skipping a
 * still-referenced style is always safe: that file's own job cleanup frees
 * it up on the very next pass.
 */
export async function deleteStylesByName(names: string[]): Promise<void> {
  if (names.length === 0) return;
  const referencedStyleIds = db
    .select({ styleId: jobs.styleId })
    .from(jobs)
    .where(isNotNull(jobs.styleId));
  await db
    .delete(styles)
    .where(and(inArray(styles.name, names), notInArray(styles.id, referencedStyleIds)));
}
