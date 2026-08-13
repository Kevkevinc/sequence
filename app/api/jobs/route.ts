import { auth } from '@clerk/nextjs/server';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { editPlans, renders } from '@/db/schema';
import { createDownloadUrl, thumbnailKeyFor } from '@/lib/storage';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob, listJobsForCreator } from '@/db/repositories/jobs';
import { getStyleById, listStyles } from '@/db/repositories/styles';
import { validateJobInput } from '@/lib/validation/job';
import { CaptionSettingsSchema } from '@/lib/render/captionSettings';
import { StyleConfigSchema } from '@/lib/styles';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  // Provision the creator row lazily on first authenticated call. The Clerk
  // `user.created` webhook normally does this at sign-up, but it is only an
  // optimization -- if it never fired (webhook not configured, delivery failed),
  // the row is created here instead of the request failing.
  const creator = await createCreatorIfNotExists(userId);

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { errors: [{ field: 'form', message: 'Request body must be valid JSON.' }] },
      { status: 400 }
    );
  }

  const pacing = typeof body.pacing === 'string' ? body.pacing : undefined;
  const styleId = typeof body.styleId === 'string' && body.styleId ? body.styleId : undefined;

  const errors = validateJobInput({
    productName: body.productName ?? '',
    lengthSeconds: body.lengthSeconds,
    pacing,
    styleId,
    variationCount: body.variationCount,
    sizingOverlayEnabled: Boolean(body.sizingOverlayEnabled),
    sizeWorn: body.sizeWorn,
    clipCount: Array.isArray(body.clips) ? body.clips.length : 0,
  });

  const clips: unknown[] = Array.isArray(body.clips) ? body.clips : [];
  const hasInvalidClip = clips.some(
    (clip: any) =>
      !clip ||
      typeof clip.storageKey !== 'string' ||
      !clip.storageKey.trim() ||
      typeof clip.originalFilename !== 'string' ||
      !clip.originalFilename.trim()
  );
  if (hasInvalidClip) {
    errors.push({
      field: 'clips',
      message: 'Each clip must have a storage key and an original filename.',
    });
  }

  // A named style must actually exist, and its own config decides whether an
  // inspiration photo is required — never trust the client's word on either.
  let style: Awaited<ReturnType<typeof getStyleById>> | undefined;
  if (styleId) {
    style = await getStyleById(styleId);
    if (!style) {
      errors.push({ field: 'styleId', message: 'Selected style does not exist.' });
    }
  }

  /*
   * Fit Inspo uploads. Validated rather than trusted: `kind` decides whether
   * the renderer cuts the background out, and a bad value there would either
   * crash the render or quietly destroy a listing screenshot.
   */
  const fitInspoImages: { storageKey: string; kind: 'person' | 'listing' }[] = Array.isArray(
    body.inspirationImages
  )
    ? body.inspirationImages
        .filter(
          (image: any) =>
            image && typeof image.storageKey === 'string' && image.storageKey.trim()
        )
        .slice(0, 4)
        .map((image: any) => ({
          storageKey: image.storageKey,
          kind: image.kind === 'listing' ? ('listing' as const) : ('person' as const),
        }))
    : [];

  const inspirationImage = body.inspirationImage;
  const hasInspirationImage = Boolean(
    inspirationImage &&
      typeof inspirationImage.storageKey === 'string' &&
      inspirationImage.storageKey.trim()
  );
  if (style) {
    const parsedConfig = StyleConfigSchema.safeParse(style.config);
    if (parsedConfig.success && parsedConfig.data.usesInspirationOverlay && !hasInspirationImage) {
      errors.push({
        field: 'inspirationImage',
        message: 'This style requires an inspiration photo upload.',
      });
    }
  }

  if (errors.length > 0) {
    return Response.json({ errors }, { status: 400 });
  }

  const job = await createJob({
    creatorId: creator.id,
    productName: body.productName,
    sizeWorn: body.sizeWorn,
    sizingOverlayEnabled: Boolean(body.sizingOverlayEnabled),
    lengthSeconds: body.lengthSeconds,
    pacing: pacing as 'slow' | 'medium' | 'fast' | undefined,
    styleId: style?.id,
    variationCount: body.variationCount,
    // Parsed rather than trusted: this arrives from the browser and lands in a
    // jsonb column the renderer reads back. An invalid shape is dropped, which
    // falls back to the inherited look rather than failing job creation over
    // something cosmetic.
    captionSettings: CaptionSettingsSchema.safeParse(body.captionSettings).data,
    kind: body.kind === 'talking' ? 'talking' : 'cuts',
    clips: body.clips,
    inspirationImage: hasInspirationImage ? { storageKey: inspirationImage.storageKey } : undefined,
    inspirationImages: fitInspoImages,
  });

  return Response.json(job, { status: 201 });
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const creator = await createCreatorIfNotExists(userId);

  const jobs = await listJobsForCreator(creator.id);

  // The list UI labels each job by its style ("30s · Mixed Cuts"), and jobs
  // only store a styleId. Resolve the whole catalogue once and map, rather
  // than a lookup per row.
  const styles = await listStyles();
  const styleNameById = new Map(styles.map((style) => [style.id, style.name]));

  /*
   * Card thumbnails are a real frame of the finished video, not a stand-in, so
   * the list needs one playable URL per job. The same pass counts how many of
   * each job's videos have landed and how many did not, which is what the list
   * and the Home screen label every card with ("4 of 10 ready") and what fills
   * the tick bars on the running card. One query for every render across all of
   * this creator's jobs, rather than a query per card.
   */
  const firstFinishedByJobId = new Map<string, string>();
  const doneByJobId = new Map<string, Set<string>>();
  const failedByJobId = new Map<string, Set<string>>();

  if (jobs.length > 0) {
    const rows = await db
      .select({
        jobId: renders.jobId,
        id: renders.id,
        editPlanId: renders.editPlanId,
        status: renders.status,
        storageKey: renders.storageKey,
      })
      .from(renders)
      // Left join, not inner: a talking-head render has no edit plan, and an
      // inner join silently drops it — the job would show as finished with no
      // video to play.
      .leftJoin(editPlans, eq(renders.editPlanId, editPlans.id))
      .where(
        inArray(
          renders.jobId,
          jobs.map((job) => job.id)
        )
      )
      .orderBy(editPlans.variationNumber);

    for (const row of rows) {
      // Counted per variation, not per row: a re-run writes a second render for
      // the same plan, and counting rows would report more finished videos than
      // the job ever asked for.
      const key = row.editPlanId ?? row.id;
      if (row.status === 'done') {
        if (!doneByJobId.has(row.jobId)) doneByJobId.set(row.jobId, new Set());
        doneByJobId.get(row.jobId)!.add(key);
        if (row.storageKey && !firstFinishedByJobId.has(row.jobId)) {
          firstFinishedByJobId.set(row.jobId, row.storageKey);
        }
      } else if (row.status === 'failed') {
        if (!failedByJobId.has(row.jobId)) failedByJobId.set(row.jobId, new Set());
        failedByJobId.get(row.jobId)!.add(key);
      }
    }
  }

  return Response.json(
    await Promise.all(
      jobs.map(async (job) => {
        const storageKey = firstFinishedByJobId.get(job.id);
        const done = doneByJobId.get(job.id) ?? new Set<string>();
        const failed = failedByJobId.get(job.id) ?? new Set<string>();
        return {
          ...job,
          styleName: job.styleId ? styleNameById.get(job.styleId) ?? null : null,
          doneCount: done.size,
          // A variation that failed and was then re-rendered successfully is
          // not a failure any more, so anything present in both counts as done.
          failedCount: [...failed].filter((key) => !done.has(key)).length,
          // Presigning a key that may not exist is fine: renders made before
          // thumbnails existed 404 on fetch, and the card falls back to its
          // placeholder rather than showing a broken image.
          thumbnailUrl: storageKey
            ? await createDownloadUrl(thumbnailKeyFor(storageKey))
            : null,
        };
      })
    )
  );
}
