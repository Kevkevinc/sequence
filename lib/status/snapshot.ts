import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { apiUsage, jobs, renders, workerHeartbeats } from '@/db/schema';
import { costOf } from '@/lib/pipeline/usage';
import { fetchRailwayUsage } from '@/lib/status/railway';

/** Statuses that mean a creator is currently waiting on us. */
const IN_FLIGHT = ['pending', 'tagging', 'planning', 'planned', 'rendering'] as const;

/** How long without a heartbeat before the worker is presumed down. */
const WORKER_STALE_SECONDS = 60;

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/**
 * Everything the dashboard shows, in one round of queries.
 *
 * Separate from the route so it can be exercised without an authenticated
 * request: this is the half with all the SQL in it, and the half most likely to
 * break silently when the schema moves.
 */
export async function buildStatusSnapshot() {
  const day = hoursAgo(24);
  const month = hoursAgo(24 * 30);

  const [
    heartbeats,
    queueCounts,
    activeJobs,
    recentFailedJobs,
    recentFailedRenders,
    doneCounts,
    usageRows,
    usageMonth,
    usageAllTime,
    railway,
  ] = await Promise.all([
    db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastSeenAt)),

    db
      .select({ status: jobs.status, count: sql<number>`count(*)::int` })
      .from(jobs)
      .groupBy(jobs.status),

    // The live queue, oldest first — the order the worker will actually take
    // them in, so the top row is what a creator has been waiting on longest.
    db
      .select({
        id: jobs.id,
        productName: jobs.productName,
        status: jobs.status,
        variationCount: jobs.variationCount,
        attempts: jobs.attempts,
        warning: jobs.warning,
        createdAt: jobs.createdAt,
        rendersDone: sql<number>`(
          select count(*)::int from ${renders}
          where ${renders.jobId} = ${jobs.id} and ${renders.status} = 'done'
        )`,
        rendersFailed: sql<number>`(
          select count(*)::int from ${renders}
          where ${renders.jobId} = ${jobs.id} and ${renders.status} = 'failed'
        )`,
      })
      .from(jobs)
      .where(inArray(jobs.status, [...IN_FLIGHT]))
      .orderBy(jobs.createdAt)
      .limit(25),

    db
      .select({
        id: jobs.id,
        productName: jobs.productName,
        failureReason: jobs.failureReason,
        attempts: jobs.attempts,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .where(and(eq(jobs.status, 'failed'), gte(jobs.createdAt, day)))
      .orderBy(desc(jobs.createdAt))
      .limit(15),

    db
      .select({
        id: renders.id,
        jobId: renders.jobId,
        failureReason: renders.failureReason,
        createdAt: renders.createdAt,
      })
      .from(renders)
      .where(and(eq(renders.status, 'failed'), gte(renders.createdAt, day), isNotNull(renders.failureReason)))
      .orderBy(desc(renders.createdAt))
      .limit(15),

    db
      .select({
        jobsDone: sql<number>`count(*) filter (where ${jobs.status} = 'done')::int`,
        jobsFailed: sql<number>`count(*) filter (where ${jobs.status} = 'failed')::int`,
      })
      .from(jobs)
      .where(gte(jobs.createdAt, day)),

    db
      .select({
        kind: apiUsage.kind,
        calls: sql<number>`count(*)::int`,
        prompt: sql<number>`coalesce(sum(${apiUsage.promptTokens}), 0)::int`,
        output: sql<number>`coalesce(sum(${apiUsage.outputTokens}), 0)::int`,
      })
      .from(apiUsage)
      .where(gte(apiUsage.createdAt, day))
      .groupBy(apiUsage.kind),

    // Two plain aggregates rather than one query bucketed by a CASE
    // expression. The bucketed form needed the cutoff as a raw parameter, and
    // a Date interpolated into a raw fragment is not serialisable by the
    // driver — it failed outright. Two trivially correct queries beat one
    // clever one for a number nobody wants to have to trust twice.
    db
      .select({
        prompt: sql<number>`coalesce(sum(${apiUsage.promptTokens}), 0)::int`,
        output: sql<number>`coalesce(sum(${apiUsage.outputTokens}), 0)::int`,
      })
      .from(apiUsage)
      .where(gte(apiUsage.createdAt, month)),

    db
      .select({
        prompt: sql<number>`coalesce(sum(${apiUsage.promptTokens}), 0)::int`,
        output: sql<number>`coalesce(sum(${apiUsage.outputTokens}), 0)::int`,
      })
      .from(apiUsage),

    fetchRailwayUsage(),
  ]);

  const now = Date.now();

  // Ages are resolved here rather than in the page. The client would have to
  // call `Date.now()` mid-render to do it, which is neither pure nor correct —
  // it would drift against the server clock the snapshot was measured on.
  const workers = heartbeats.map((beat) => ({
    id: beat.id,
    activity: beat.activity,
    startedAt: beat.startedAt,
    lastSeenAt: beat.lastSeenAt,
    secondsAgo: Math.round((now - new Date(beat.lastSeenAt).getTime()) / 1000),
    uptimeSeconds: Math.round((now - new Date(beat.startedAt).getTime()) / 1000),
  }));
  const liveWorkers = workers.filter((w) => w.secondsAgo <= WORKER_STALE_SECONDS);

  const byStatus = Object.fromEntries(queueCounts.map((row) => [row.status, row.count]));

  const usageByKind = usageRows.map((row) => ({
    kind: row.kind,
    calls: row.calls,
    promptTokens: row.prompt,
    outputTokens: row.output,
    costUsd: costOf(row.prompt, row.output),
  }));

  const monthTokens = (usageMonth[0]?.prompt ?? 0) + (usageMonth[0]?.output ?? 0);
  const costMonth = costOf(usageMonth[0]?.prompt ?? 0, usageMonth[0]?.output ?? 0);
  const costAllTime = costOf(usageAllTime[0]?.prompt ?? 0, usageAllTime[0]?.output ?? 0);

  return {
    generatedAt: new Date().toISOString(),
    worker: {
      // "Alive" is a claim about right now, so it is derived from the
      // heartbeat's age rather than from the row merely existing.
      alive: liveWorkers.length > 0,
      staleAfterSeconds: WORKER_STALE_SECONDS,
      instances: workers.slice(0, 5),
    },
    queue: {
      counts: {
        pending: byStatus.pending ?? 0,
        tagging: byStatus.tagging ?? 0,
        planning: byStatus.planning ?? 0,
        planned: byStatus.planned ?? 0,
        rendering: byStatus.rendering ?? 0,
      },
      inFlight: activeJobs.map((job) => ({
        ...job,
        waitingSeconds: Math.round((now - new Date(job.createdAt).getTime()) / 1000),
      })),
    },
    last24h: {
      jobsDone: doneCounts[0]?.jobsDone ?? 0,
      jobsFailed: doneCounts[0]?.jobsFailed ?? 0,
      failedJobs: recentFailedJobs,
      failedRenders: recentFailedRenders,
    },
    api: {
      last24h: {
        calls: usageByKind.reduce((total, row) => total + row.calls, 0),
        costUsd: usageByKind.reduce((total, row) => total + row.costUsd, 0),
        byKind: usageByKind,
      },
      costMonthUsd: costMonth,
      costAllTimeUsd: costAllTime,
      tokensMonth: monthTokens,
    },
    railway,
  };
}
