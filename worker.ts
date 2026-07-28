import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips } from '@/db/schema';
import { tagClip } from '@/lib/pipeline/tagging';
import { planJob } from '@/lib/pipeline/director';
import { describeCause } from '@/lib/pipeline/errors';

const POLL_INTERVAL_MS = 5000;

/**
 * How many clips may be tagged at once.
 *
 * Was unbounded (`Promise.all(clips.map(...))`). Each `tagClip` streams a whole
 * video through the machine and hands it to Gemini, so a six-clip job of raw
 * phone footage fanned out six simultaneous multi-hundred-megabyte uploads —
 * enough to be OOM-killed, which strands the job in `tagging` with nothing to
 * reap it. It also fired N requests at Gemini at once, manufacturing the very
 * 429s the retry layer then had to absorb.
 *
 * Two is small enough to bound both, and still overlaps one clip's upload with
 * the previous clip's analysis, which is where nearly all the wall-clock saving
 * of parallelism came from in the first place.
 */
const TAG_CONCURRENCY = 2;

/**
 * `Promise.all(items.map(fn))` with a ceiling on how many run at once.
 *
 * Results stay in input order, so callers can still line them up against the
 * input array. Rejections propagate exactly as `Promise.all`'s would; `tagClip`
 * never throws, so in practice they do not arise.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  operation: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = nextIndex++; index < items.length; index = nextIndex++) {
      results[index] = await operation(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

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
 *
 * `restrictToCreatorId` narrows the queue to one creator's jobs. Production
 * never passes it — the queue is global and oldest-first, which is correct.
 * It exists because the test suite runs against the shared dev database, where
 * an unscoped claim once grabbed a real creator's job and stranded it in
 * `tagging`. Tests pass their own throwaway creator's id so a test run can only
 * ever claim jobs that same test seeded. It narrows the row set only; the
 * ordering and the `FOR UPDATE SKIP LOCKED` claim are untouched, so the
 * concurrency behaviour under test is exactly production's.
 */
export async function claimNextPendingJob(
  options: { restrictToCreatorId?: string } = {}
): Promise<{ id: string } | undefined> {
  const claimable = options.restrictToCreatorId
    ? and(eq(jobs.status, 'pending'), eq(jobs.creatorId, options.restrictToCreatorId))
    : eq(jobs.status, 'pending');

  const [claimed] = await db
    .update(jobs)
    .set({ status: 'tagging' })
    .where(
      and(
        claimable,
        eq(
          jobs.id,
          db
            .select({ id: jobs.id })
            .from(jobs)
            .where(claimable)
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
  // Distinguishes "the pipeline broke" from "the pipeline finished but the
  // bookkeeping write failed", which are very different things to report.
  let plansCommitted = false;

  try {
    const clips = await db.select().from(rawClips).where(eq(rawClips.jobId, jobId));

    if (clips.length === 0) {
      await failJob(jobId, 'Job has no clips to edit');
      return;
    }

    const tagResults = await mapWithConcurrency(clips, TAG_CONCURRENCY, (clip) =>
      tagClip(clip.id)
    );
    const failedTags = clips
      .map((clip, index) => ({ clip, result: tagResults[index] }))
      .filter((tagged) => !tagged.result.success);

    if (failedTags.length === clips.length) {
      const reasons = failedTags
        .map((tagged) => (tagged.result.success ? '' : tagged.result.error))
        .filter(Boolean)
        .join('; ');
      await failJob(jobId, `All clips failed tagging: ${reasons}`);
      return;
    }

    if (failedTags.length > 0) {
      // The job carries on, but the creator's edit is cut from less footage
      // than they uploaded. The job row stays clean (it did succeed), so the
      // log is the only place this is recorded — say which clips were dropped.
      const detail = failedTags
        .map((tagged) => `${tagged.clip.id} (${tagged.result.success ? '' : tagged.result.error})`)
        .join('; ');
      console.warn(
        `Job ${jobId}: ${failedTags.length} of ${clips.length} clips failed tagging and are ` +
          `excluded from the edit: ${detail}`
      );
    }

    await db.update(jobs).set({ status: 'planning' }).where(eq(jobs.id, jobId));

    const planResult = await planJob(jobId);

    if (!planResult.success) {
      await failJob(jobId, planResult.error);
      return;
    }

    plansCommitted = true;

    if (planResult.warning) {
      // Already stored on the job for the creator to read; logged too so the
      // reason a job produced short videos is visible in the worker's output.
      console.warn(`Job ${jobId}: ${planResult.warning}`);
    }

    await db
      .update(jobs)
      .set({ status: 'planned', failureReason: null })
      .where(eq(jobs.id, jobId));
  } catch (error) {
    // `planJob` has already written its edit_plans rows by this point, so
    // reporting a generic pipeline failure would be actively wrong: the plans
    // exist and only the status write is missing.
    await failJob(
      jobId,
      plansCommitted
        ? `Edit plans were generated but the job could not be marked planned: ${describeCause(error)}`
        : `Unexpected worker error: ${describeCause(error)}`
    );
  }
}

let shuttingDown = false;
/** Set while the worker is idling between polls, so a signal can cut the wait short. */
let wakeFromPoll: (() => void) | undefined;

function sleepUntilNextPoll(): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      wakeFromPoll = undefined;
      resolve();
    };
    const timer = setTimeout(finish, POLL_INTERVAL_MS);
    wakeFromPoll = finish;
  });
}

/**
 * Stops the worker claiming anything new, but lets the job already in flight
 * run to completion. Without this, a deploy or a Ctrl-C mid-job abandons that
 * job in `tagging`/`planning` with nothing to move it on. A second signal
 * gives up waiting and exits immediately.
 */
function requestShutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    console.warn(`Received ${signal} again, exiting without waiting for the current job.`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`Received ${signal}, finishing the current job before exiting...`);
  wakeFromPoll?.();
}

async function main() {
  process.on('SIGTERM', requestShutdown);
  process.on('SIGINT', requestShutdown);

  console.log(
    `Worker started, polling for pending jobs every ${POLL_INTERVAL_MS / 1000} seconds...`
  );

  while (!shuttingDown) {
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
    if (shuttingDown) break;
    await sleepUntilNextPoll();
  }

  console.log('Worker stopped.');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Worker exited unexpectedly:', error);
      process.exit(1);
    });
}
