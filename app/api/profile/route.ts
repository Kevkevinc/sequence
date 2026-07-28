import { auth } from '@clerk/nextjs/server';
import { getCreatorByClerkId, updateCreatorProfile } from '@/db/repositories/creators';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const creator = await getCreatorByClerkId(userId);
  return Response.json(creator);
}

export async function PATCH(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const body = await req.json();
  const updated = await updateCreatorProfile(userId, {
    height: body.height,
    weight: body.weight,
  });
  return Response.json(updated);
}
