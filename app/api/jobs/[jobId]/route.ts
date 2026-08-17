import { auth } from '@clerk/nextjs/server';
import { inArray, eq, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { editPlans, rawClips, renders } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { getJobForCreator } from '@/db/repositories/jobs';
import { getStyleById } from '@/db/repositories/styles';
import { createDownloadUrl, thumbnailKeyFor } from '@/lib/storage';

type VariationResponse = {
  variationNumber: number;
  hookText: string;
  /** `pending` means the job hasn't reached this variation's render yet. */
  status: 'pending' | 'rendering' | 'done' | 'failed';
  durationSeconds: number | null;
  playbackUrl: string | null;
  /**
   * Same object as `playbackUrl`, presigned to download rather than play.
   * Separate URL because the two need opposite Content-Dispositions.
   */
  downloadUrl: string | null;
  /** Still frame shown before playback, so the player isn't a black box. */
  thumbnailUrl: string | null;
  failureReason: string | null;
};

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const creator = await createCreatorIfNotExists(userId);

  const { jobId } = await context.params;
  const job = await getJobForCreator(jobId, creator.id);
  // Not found and "belongs to someone else" return the same 404: which jobs
  // exist is not this route's business to reveal to a creator who doesn't own them.
  if (!job) return new Response('Not found', { status: 404 });

  /*
   * A talking job has no edit plans — its cuts come from the audio — so its one
   * finished video is read straight off the renders table and presented as a
   * single "variation". The client renders both editors' results from one
   * shape, which is the point: the delivery surface should not care which
   * pipeline produced a video.
   */
  if (job.kind === 'talking') {
    const [render] = await db
      .select()
      .from(renders)
      .where(eq(renders.jobId, job.id))
      .orderBy(desc(renders.createdAt))
      .limit(1);

    const variation: VariationResponse = render
      ? {
          variationNumber: 1,
          hookText: '',
          status: render.status,
          durationSeconds:
            render.status === 'done' && render.durationSeconds !== null
              ? Number(render.durationSeconds)
              : null,
          playbackUrl:
            render.status === 'done' && render.storageKey
              ? await createDownloadUrl(render.storageKey)
              : null,
          downloadUrl:
            render.status === 'done' && render.storageKey
              ? await createDownloadUrl(render.storageKey, { downloadAs: job.productName })
              : null,
          thumbnailUrl:
            render.status === 'done' && render.storageKey
              ? await createDownloadUrl(thumbnailKeyFor(render.storageKey))
              : null,
          failureReason: render.status === 'failed' ? render.failureReason : null,
        }
      : {
          variationNumber: 1,
          hookText: '',
          status: 'pending',
          durationSeconds: null,
          playbackUrl: null,
          downloadUrl: null,
          thumbnailUrl: null,
          failureReason: null,
        };

    return Response.json({
      ...job,
      styleName: null,
      clipCount: (await db.select().from(rawClips).where(eq(rawClips.jobId, job.id))).length,
      variations: [variation],
    });
  }

  const plans = await db
    .select()
    .from(editPlans)
    .where(eq(editPlans.jobId, job.id))
    .orderBy(editPlans.variationNumber);

  const renderRows =
    plans.length > 0
      ? await db
          .select()
          .from(renders)
          .where(inArray(renders.editPlanId, plans.map((p) => p.id)))
      : [];

  // A plan should have at most one renders row (the worker renders each job
  // once), but nothing prevents a re-run from producing a second, so keep
  // only the most recent per plan rather than trusting that invariant.
  const latestRenderByPlanId = new Map<string, (typeof renderRows)[number]>();
  for (const row of renderRows) {
    // `editPlanId` is nullable since talking mode, but this loop only ever sees
    // rows fetched by plan id, so a null here would be a row that cannot be
    // attributed to a variation — skipped rather than keyed under "null".
    if (!row.editPlanId) continue;
    const existing = latestRenderByPlanId.get(row.editPlanId);
    if (!existing || row.createdAt > existing.createdAt) {
      latestRenderByPlanId.set(row.editPlanId, row);
    }
  }

  const variations: VariationResponse[] = await Promise.all(
    plans.map(async (plan) => {
      const render = latestRenderByPlanId.get(plan.id);

      if (!render) {
        return {
          variationNumber: plan.variationNumber,
          hookText: plan.hookText,
          status: 'pending',
          durationSeconds: null,
          playbackUrl: null,
          downloadUrl: null,
          thumbnailUrl: null,
          failureReason: null,
        };
      }

      if (render.status === 'done') {
        return {
          variationNumber: plan.variationNumber,
          hookText: plan.hookText,
          status: 'done',
          durationSeconds: render.durationSeconds !== null ? Number(render.durationSeconds) : null,
          // storageKey is only ever null while a render is in flight; a `done`
          // row always has one, but the column itself is nullable in the schema.
          playbackUrl: render.storageKey ? await createDownloadUrl(render.storageKey) : null,
          downloadUrl: render.storageKey
            ? await createDownloadUrl(render.storageKey, {
                downloadAs: `${job.productName}-v${plan.variationNumber}`,
              })
            : null,
          // Presigning a key that may not exist is fine: renders made before
          // thumbnails existed 404 on fetch and the player falls back to its
          // own black first frame, exactly as it behaved before.
          thumbnailUrl: render.storageKey
            ? await createDownloadUrl(thumbnailKeyFor(render.storageKey))
            : null,
          failureReason: null,
        };
      }

      return {
        variationNumber: plan.variationNumber,
        hookText: plan.hookText,
        status: render.status,
        durationSeconds: null,
        playbackUrl: null,
        downloadUrl: null,
        thumbnailUrl: null,
        failureReason: render.status === 'failed' ? render.failureReason : null,
      };
    })
  );

  // Style-mode jobs have no `pacing`; the detail header labels them by style
  // name instead, so resolve it here rather than making the client fetch the
  // whole catalogue just to name one job.
  const style = job.styleId ? await getStyleById(job.styleId) : undefined;

  // Clip count drives the time estimate the page shows: tagging is one Gemini
  // round trip per clip and is by far the longest stage, so an estimate that
  // ignores how many clips were uploaded is wrong by minutes.
  const clips = await db.select({ id: rawClips.id }).from(rawClips).where(eq(rawClips.jobId, job.id));

  return Response.json({
    id: job.id,
    productName: job.productName,
    status: job.status,
    // Which editor made this. The detail screen labels a talking job by that
    // rather than by a pacing it does not have.
    kind: job.kind,
    lengthSeconds: job.lengthSeconds,
    pacing: job.pacing,
    styleName: style?.name ?? null,
    variationCount: job.variationCount,
    quality: job.quality,
    clipCount: clips.length,
    warning: job.warning,
    failureReason: job.failureReason,
    createdAt: job.createdAt,
    variations,
  });
}
