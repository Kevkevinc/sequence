import { auth } from '@clerk/nextjs/server';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob, listJobsForCreator } from '@/db/repositories/jobs';
import { validateJobInput } from '@/lib/validation/job';

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

  const errors = validateJobInput({
    productName: body.productName ?? '',
    lengthSeconds: body.lengthSeconds,
    pacing: body.pacing,
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

  if (errors.length > 0) {
    return Response.json({ errors }, { status: 400 });
  }

  const job = await createJob({
    creatorId: creator.id,
    productName: body.productName,
    sizeWorn: body.sizeWorn,
    sizingOverlayEnabled: Boolean(body.sizingOverlayEnabled),
    lengthSeconds: body.lengthSeconds,
    pacing: body.pacing,
    variationCount: body.variationCount,
    clips: body.clips,
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
