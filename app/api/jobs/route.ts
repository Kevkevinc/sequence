import { auth } from '@clerk/nextjs/server';
import { getCreatorByClerkId } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { validateJobInput } from '@/lib/validation/job';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const creator = await getCreatorByClerkId(userId);
  if (!creator) return new Response('Creator profile not found', { status: 404 });

  const body = await req.json();
  const errors = validateJobInput({
    productName: body.productName ?? '',
    lengthSeconds: body.lengthSeconds,
    pacing: body.pacing,
    variationCount: body.variationCount,
    sizingOverlayEnabled: Boolean(body.sizingOverlayEnabled),
    sizeWorn: body.sizeWorn,
    clipCount: Array.isArray(body.clips) ? body.clips.length : 0,
  });

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
