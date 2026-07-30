import { auth } from '@clerk/nextjs/server';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob, listJobsForCreator } from '@/db/repositories/jobs';
import { getStyleById } from '@/db/repositories/styles';
import { validateJobInput } from '@/lib/validation/job';
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
    clips: body.clips,
    inspirationImage: hasInspirationImage ? { storageKey: inspirationImage.storageKey } : undefined,
  });

  return Response.json(job, { status: 201 });
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const creator = await createCreatorIfNotExists(userId);

  const jobs = await listJobsForCreator(creator.id);
  return Response.json(jobs);
}
