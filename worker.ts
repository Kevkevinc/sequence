import { and, eq, inArray, isNull, like, notExists, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips, editPlans, renders, creators, jobStatusEnum } from '@/db/schema';
import { tagClip } from '@/lib/pipeline/tagging';
import { planJob } from '@/lib/pipeline/director';
import { describeCause } from '@/lib/pipeline/errors';
import { isTransientError } from '@/lib/pipeline/retry';
import { renderPlan } from '@/lib/render/renderPlan';

const POLL_INTERVAL_MS = 5000;

/* ------------------------------------------------------- timed logging --- */

/** Wall-clock stamp, local time, so a line can be matched against what a creator saw. */
function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function log(message: string): void {
  console.log(`[${stamp()}] ${message}`);
}

/** Seconds to one decimal — the resolution that matters for a step taking 10s-10min. */
function since(startedAt: number): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

/**
 * Runs a pipeline step, printing when it starts and how long it took.
 *
 * Every stage is timed the same way so the log reads as a breakdown rather
 * than as scattered progress notes -- when a job feels slow, the point is to
 * see *which* step ate the time without instrumenting it after the fact.
 */
async function timed<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  log(`  ${label}...`);
  try {
    const result = await operation();
    log(`  ${label} finished in ${since(startedAt)}`);
    return result;
  } catch (error) {
    log(`  ${label} FAILED after ${since(startedAt)}`);
    throw error;
  }
}

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

type JobStatus = (typeof jobStatusEnum.enumValues)[number];

/**
 * Matches the creator row behind `creatorId` when it is a test fixture.
 *
 * Test creators are seeded with a `test_clerk_user...` id; no Clerk-issued id
 * takes that form, so real work is never excluded. The escape on `_` matters:
 * unescaped it is a single-character wildcard, which would also match a real
 * id beginning "testX".
 */
function testCreatorFor(creatorId: typeof jobs.creatorId) {
  return db
    .select({ one: sql`1` })
    .from(creators)
    .where(and(eq(creators.id, creatorId), like(creators.clerkUserId, 'test\\_%')));
}

/**
 * Takes ownership of the oldest job in `fromStatus`, flipping it to `toStatus`,
 * and returns it. Returns `undefined` when there is nothing to claim.
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
 *    claimable in the sub-select and both claim it (verified: 6 concurrent
 *    claims handed out only 3 distinct jobs). With it, the second worker's
 *    sub-select skips the row the first has locked and picks the next one.
 *  - The redundant outer `status = fromStatus` is belt and braces: if a
 *    concurrent update ever does slip through, Postgres re-checks the WHERE
 *    clause against the updated row, sees the new status, and claims nothing.
 *
 * `restrictToCreatorId` narrows the queue to one creator's jobs. Production
 * never passes it — the queue is global and oldest-first, which is correct.
 * It exists because the test suite runs against the shared dev database, where
 * an unscoped claim once grabbed a real creator's job and stranded it. Tests
 * pass their own throwaway creator's id so a test run can only ever claim jobs
 * that same test seeded. It narrows the row set only; the ordering and the
 * `FOR UPDATE SKIP LOCKED` claim are untouched, so the concurrency behaviour
 * under test is exactly production's.
 *
 * Shared by both stages of the pipeline this worker drives — `pending` into
 * tagging and `planned` into rendering — rather than writing the same
 * statement twice, which is exactly how a future third stage would drift out
 * of sync with the atomicity guarantee above.
 */
async function claimJob(
  fromStatus: JobStatus,
  toStatus: JobStatus,
  options: { restrictToCreatorId?: string } = {}
): Promise<{ id: string } | undefined> {
  const claimable = options.restrictToCreatorId
    ? and(eq(jobs.status, fromStatus), eq(jobs.creatorId, options.restrictToCreatorId))
    : // Production claims the queue globally, but the suite runs against this
      // same database and seeds its own jobs. Without this exclusion a running
      // worker races the tests for those rows and wins -- which fails a
      // different assertion on every run, since whichever test seeded a job
      // most recently is the one robbed. Tests scope *their* claims to a
      // throwaway creator; this is the other half of that guard.
      and(eq(jobs.status, fromStatus), notExists(testCreatorFor(jobs.creatorId)));

  const [claimed] = await db
    .update(jobs)
    .set({ status: toStatus })
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

export async function claimNextPendingJob(
  options: { restrictToCreatorId?: string } = {}
): Promise<{ id: string } | undefined> {
  return claimJob('pending', 'tagging', options);
}

export async function claimNextPlannedJob(
  options: { restrictToCreatorId?: string } = {}
): Promise<{ id: string } | undefined> {
  return claimJob('planned', 'rendering', options);
}

/**
 * How many times a job may be put back on the queue before giving up.
 *
 * Guards against a model outage cycling one job forever, while being generous
 * enough to ride one out: the retries inside a single call cover seconds, this
 * covers the minutes an actual capacity spike lasts.
 */
const MAX_JOB_ATTEMPTS = 4;

/**
 * Puts a job back on the queue instead of failing it.
 *
 * A transient Gemini failure at the *planning* call used to destroy the whole
 * job: the creator had already waited through four minutes of tagging, the
 * segments were sitting in the database, and one 503 at the end threw all of it
 * away with nothing to resume from. Tagging now skips clips it has already
 * done, so a requeued job costs a few seconds and no extra quota to reach the
 * step that failed.
 *
 * Returns false when the job has used up its attempts and should fail properly.
 */
async function requeueForTransientFailure(jobId: string, reason: string): Promise<boolean> {
  const [job] = await db.select({ attempts: jobs.attempts }).from(jobs).where(eq(jobs.id, jobId));
  const attempts = (job?.attempts ?? 0) + 1;
  if (attempts >= MAX_JOB_ATTEMPTS) return false;

  await db
    .update(jobs)
    .set({ status: 'pending', attempts, warning: `Retrying after a temporary AI outage: ${reason}` })
    .where(eq(jobs.id, jobId));
  log(`  job ${jobId} hit a transient failure, requeued (attempt ${attempts}/${MAX_JOB_ATTEMPTS})`);
  return true;
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

    const tagResults = await timed(`Tagging ${clips.length} clips`, () =>
      mapWithConcurrency(clips, TAG_CONCURRENCY, (clip) => tagClip(clip.id))
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

    const planResult = await timed('Planning cuts', () => planJob(jobId));

    if (!planResult.success) {
      // The tagging above is already saved, so a requeue resumes here rather
      // than starting over -- which is the difference between a slow job and a
      // destroyed one.
      if (isTransientError(planResult.error) && (await requeueForTransientFailure(jobId, planResult.error))) {
        return;
      }
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

type RenderOutcome = { variationNumber: number; success: boolean; error?: string };

/**
 * Renders one variation and returns how it went — never throws.
 *
 * `renderPlan` is itself documented as never throwing, but trusting that as a
 * hard guarantee here would be exactly the assumption that leaves a job stuck
 * forever if it is ever wrong, whether from a bug in `renderPlan` or from the
 * row-update write below failing on its own. Catching per-variation means one
 * throw marks only *this* row failed and lets the loop move on to the next
 * variation, rather than aborting every variation still to come — which is
 * the isolation this function exists to provide in the first place.
 */
/**
 * Ceiling on one variation, end to end.
 *
 * Every individual step has its own timeout now, but "every step I thought of"
 * is not the same as "every step": a deployed render sat in `rendering` for 75
 * minutes because a stalled R2 download was outside all of them. This is the
 * backstop -- whatever hangs, the variation fails and the job moves on instead
 * of the whole thing stranding forever.
 *
 * Generous on purpose, and raised alongside the move to a 4K output frame,
 * which costs roughly 3-4x the encode time of the 1080p frame this number was
 * first chosen for. It has to sit clear above the slowest *healthy* variation
 * or it stops being a backstop and starts being the thing that fails renders.
 */
const VARIATION_TIMEOUT_MS = 45 * 60 * 1000;

async function renderVariation(jobId: string, plan: typeof editPlans.$inferSelect): Promise<RenderOutcome> {
  let renderRowId: string | undefined;
  try {
    const [renderRow] = await db
      .insert(renders)
      .values({ editPlanId: plan.id, jobId, status: 'rendering' })
      .returning({ id: renders.id });
    renderRowId = renderRow.id;

    const result = await Promise.race([
      renderPlan(plan.id),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Rendering this variation exceeded ${VARIATION_TIMEOUT_MS / 60000} minutes and was abandoned.`)),
          VARIATION_TIMEOUT_MS
        )
      ),
    ]);

    if (result.success) {
      await db
        .update(renders)
        .set({
          status: 'done',
          storageKey: result.storageKey,
          durationSeconds: result.durationSeconds.toString(),
        })
        .where(eq(renders.id, renderRowId));
      return { variationNumber: plan.variationNumber, success: true };
    }

    await db
      .update(renders)
      .set({ status: 'failed', failureReason: result.error })
      .where(eq(renders.id, renderRowId));
    return { variationNumber: plan.variationNumber, success: false, error: result.error };
  } catch (error) {
    const message = describeCause(error);
    if (renderRowId) {
      await db
        .update(renders)
        .set({ status: 'failed', failureReason: message })
        .where(eq(renders.id, renderRowId))
        .catch(() => {});
    }
    return { variationNumber: plan.variationNumber, success: false, error: message };
  }
}

/** Renders the detail list ("variation 2 (reason); variation 4 (reason)") shared by both failure messages below. */
function describeFailedVariations(outcomes: RenderOutcome[]): string {
  return outcomes
    .filter((o) => !o.success)
    .map((o) => `variation ${o.variationNumber} (${o.error})`)
    .join('; ');
}

/**
 * Runs one claimed job through rendering, leaving it in `done` or `failed`.
 *
 * Rendering is best effort per variation, the same policy `processJob` uses
 * for clips: as long as one variation renders there is a usable video to hand
 * back, the job carries on, and every variation is still attempted regardless
 * of how an earlier one went. Only a total wipeout fails the job. Each
 * variation gets its own `renders` row, updated as it resolves, so a creator
 * can see which of their videos are ready even before the whole job finishes.
 *
 * Cannot leave the job stuck in `rendering`: the per-variation isolation in
 * {@link renderVariation} means nothing inside the loop can throw past it, so
 * the only way to reach here without a final status write is the initial
 * `editPlans` lookup failing — a real but narrow case, handled below.
 */
export async function renderJob(jobId: string): Promise<void> {
  try {
    const plans = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));

    if (plans.length === 0) {
      await failJob(jobId, 'Job has no edit plans to render');
      return;
    }

    const outcomes: RenderOutcome[] = [];
    for (const plan of plans) {
      // Not wrapped in timed(): renderVariation returns failure instead of
      // throwing, and timed() would log "finished" either way -- which made a
      // run of ten fast FAILURES read like ten fast successes. Log the actual
      // outcome instead.
      const startedAt = Date.now();
      log(`  Rendering variation ${plan.variationNumber} of ${plans.length}...`);
      const outcome = await renderVariation(jobId, plan);
      log(
        outcome.success
          ? `  Variation ${plan.variationNumber} done in ${since(startedAt)}`
          : `  Variation ${plan.variationNumber} FAILED in ${since(startedAt)}: ${outcome.error}`
      );
      outcomes.push(outcome);
    }

    const succeeded = outcomes.filter((o) => o.success).length;

    if (succeeded === 0) {
      await failJob(jobId, `All variations failed to render: ${describeFailedVariations(outcomes)}`);
      return;
    }

    if (succeeded < outcomes.length) {
      // The row carries its own reason; the job row stays clean (it did
      // succeed), so the log is the only place a partial drop is recorded.
      console.warn(
        `Job ${jobId}: ${outcomes.length - succeeded} of ${outcomes.length} variations failed to ` +
          `render: ${describeFailedVariations(outcomes)}`
      );
    }

    try {
      await db.update(jobs).set({ status: 'done', failureReason: null }).where(eq(jobs.id, jobId));
    } catch (error) {
      // Every render row is already correctly `done`/`failed` by this point —
      // only this last write failed. Falling through to the outer catch's
      // `failJob` here would report a failed job when watchable video already
      // exists, the exact misreport `processJob`'s `plansCommitted` flag
      // exists to prevent for tagging; this is the same guard for rendering.
      console.error(
        `Job ${jobId}: rendered successfully but could not be marked done: ${describeCause(error)}`
      );
    }
  } catch (error) {
    await failJob(jobId, `Unexpected worker error while rendering: ${describeCause(error)}`);
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

/**
 * Recovers jobs orphaned in `rendering` by a worker that died mid-render.
 *
 * A render that is interrupted -- an OOM kill, a Railway redeploy, a crash --
 * leaves the job stuck in `rendering` with a half-written render row and
 * nothing to resume it: the poll loop only ever claims `planned` jobs, so a
 * `rendering` job is invisible to it forever. This runs once at startup, before
 * the loop, and puts those jobs back on the render queue.
 *
 * Deleting the incomplete render rows first (rendering + no file) means the
 * re-render starts clean; any variation that DID finish keeps its `done` row
 * and its uploaded video, so the work already paid for is not redone.
 *
 * Safe because this worker is single-instance: nothing else is rendering when
 * it boots, so a `rendering` job at startup is always an orphan, never one in
 * flight elsewhere.
 */
async function reclaimOrphanedRenders(): Promise<void> {
  const orphaned = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, 'rendering'));
  if (orphaned.length === 0) return;

  let requeued = 0;
  for (const { id } of orphaned) {
    const [job] = await db.select({ attempts: jobs.attempts }).from(jobs).where(eq(jobs.id, id));
    // Cap it: a render that dies every time -- an OOM, a container too small --
    // must not be requeued forever. Past the cap it fails cleanly instead of
    // spinning the worker on a job it can never finish.
    if ((job?.attempts ?? 0) >= MAX_JOB_ATTEMPTS) {
      await failJob(id, 'The render could not be completed after several attempts.');
      continue;
    }
    const plans = await db.select({ id: editPlans.id }).from(editPlans).where(eq(editPlans.jobId, id));
    if (plans.length > 0) {
      await db
        .delete(renders)
        .where(
          and(
            inArray(renders.editPlanId, plans.map((p) => p.id)),
            eq(renders.status, 'rendering'),
            isNull(renders.storageKey)
          )
        );
    }
    await db.update(jobs).set({ status: 'planned', attempts: (job?.attempts ?? 0) + 1 }).where(eq(jobs.id, id));
    requeued += 1;
  }
  if (requeued > 0) log(`Recovered ${requeued} job(s) orphaned mid-render, requeued for rendering`);
}

async function main() {
  process.on('SIGTERM', requestShutdown);
  process.on('SIGINT', requestShutdown);

  await reclaimOrphanedRenders();


  console.log(
    `Worker started, polling for pending jobs every ${POLL_INTERVAL_MS / 1000} seconds...`
  );

  while (!shuttingDown) {
    try {
      // Rendering is checked first: it finishes work a creator is already
      // waiting on, where tagging only starts new work. Preferring it keeps
      // the `planned` queue from growing behind a steady stream of new jobs.
      const readyToRender = await claimNextPlannedJob();
      if (readyToRender) {
        const startedAt = Date.now();
        log(`RENDER STAGE  job ${readyToRender.id}`);
        await renderJob(readyToRender.id);
        log(`RENDER STAGE  job ${readyToRender.id} done in ${since(startedAt)}\n`);
        continue;
      }

      const readyToTag = await claimNextPendingJob();
      if (readyToTag) {
        const startedAt = Date.now();
        log(`AI STAGE      job ${readyToTag.id}`);
        await processJob(readyToTag.id);
        log(`AI STAGE      job ${readyToTag.id} done in ${since(startedAt)}`);
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
