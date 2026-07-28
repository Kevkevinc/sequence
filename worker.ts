import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips } from '@/db/schema';
import { tagClip } from '@/lib/pipeline/tagging';
import { planJob } from '@/lib/pipeline/director';
import { describeCause } from '@/lib/pipeline/errors';

const POLL_INTERVAL_MS = 5000;

/**
 * Takes ownership of the oldest `pending` job, flipping it to `tagging`, and
 * returns it. Returns `undefined` when the queue is empty.
 *
 * This is deliberately a single `UPDATE ... WHERE id = (SELECT ... FOR UPDATE
 * SKIP LOCKED LIMIT 1)` statement, which is the standard Postgres queue claim:
 *
 *  - One statement means one implicit transaction, so the row lock is taken and
 *    released within it. That matters because DATABASE_URL points at Supabase's
 *    transaction-mode pooler, where a multi-statement "select then update"
 *    is not guaranteed to stay on one backend connection.
 *  - `FOR UPDATE SKIP LOCKED` is what makes the claim exclusive. Without it, two
 *    workers running concurrently under READ COMMITTED both see the same row as
 *    `pending` in the sub-select and both claim it (verified: 6 concurrent
 *    claims handed out only 3 distinct jobs). With it, the second worker's
 *    sub-select skips the row the first has locked and picks the next one.
 *  - The redundant outer `status = 'pending'` is belt and braces: if a
 *    concurrent update ever does slip through, Postgres re-checks the WHERE
 *    clause against the updated row, sees `tagging`, and claims nothing.
 */
export async function claimNextPendingJob(): Promise<{ id: string } | undefined> {
  const [claimed] = await db
    .update(jobs)
    .set({ status: 'tagging' })
    .where(
      and(
        eq(jobs.status, 'pending'),
        eq(
          jobs.id,
          db
            .select({ id: jobs.id })
            .from(jobs)
            .where(eq(jobs.status, 'pending'))
            // Oldest first, so a job cannot be starved by newer arrivals.
            .orderBy(jobs.createdAt)
            .limit(1)
            .for('update', { skipLocked: true })
        )
      )
    )
    .returning({ id: jobs.id });

  return claimed;
}

/** Records a terminal failure. Never throws: the caller is already failing. */
async function failJob(jobId: string, reason: string): Promise<void> {
  try {
    await db
      .update(jobs)
      .set({ status: 'failed', failureReason: reason })
      .where(eq(jobs.id, jobId));
  } catch (error) {
    console.error(`Could not record failure for job ${jobId}: ${describeCause(error)}`);
  }
}

/**
 * Runs one claimed job through tagging and directing, leaving it in `planned`
 * or `failed`.
 *
 * Tagging is best effort per clip: as long as one clip yields segments there is
 * still footage to cut from, so the job carries on with the successes. Only a
 * total tagging wipeout fails the job.
 *
 * Everything is wrapped so that an unexpected throw (a dropped database
 * connection, a bug in a pipeline stage) still lands the job in `failed` with a
 * reason rather than leaving it stuck in `tagging`/`planning` forever, where
 * nothing would ever pick it up again.
 */
export async function processJob(jobId: string): Promise<void> {
  try {
    const clips = await db.select().from(rawClips).where(eq(rawClips.jobId, jobId));

    if (clips.length === 0) {
      await failJob(jobId, 'Job has no clips to edit');
      return;
    }

    const tagResults = await Promise.all(clips.map((clip) => tagClip(clip.id)));

    if (!tagResults.some((r) => r.success)) {
      const reasons = tagResults.map((r) => (r.success ? '' : r.error)).filter(Boolean).join('; ');
      await failJob(jobId, `All clips failed tagging: ${reasons}`);
      return;
    }

    await db.update(jobs).set({ status: 'planning' }).where(eq(jobs.id, jobId));

    const planResult = await planJob(jobId);

    if (!planResult.success) {
      await failJob(jobId, planResult.error);
      return;
    }

    await db
      .update(jobs)
      .set({ status: 'planned', failureReason: null })
      .where(eq(jobs.id, jobId));
  } catch (error) {
    await failJob(jobId, `Unexpected worker error: ${describeCause(error)}`);
  }
}

async function main() {
  console.log(
    `Worker started, polling for pending jobs every ${POLL_INTERVAL_MS / 1000} seconds...`
  );
  for (;;) {
    try {
      const claimed = await claimNextPendingJob();
      if (claimed) {
        console.log(`Processing job ${claimed.id}...`);
        await processJob(claimed.id);
        console.log(`Finished job ${claimed.id}.`);
        continue;
      }
    } catch (error) {
      // A failed claim (e.g. the database is briefly unreachable) must not kill
      // the worker; back off and try the next poll.
      console.error(`Worker poll failed: ${describeCause(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (require.main === module) {
  main();
}
