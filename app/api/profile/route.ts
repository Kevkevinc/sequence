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

  // Validate that at least one field is provided
  if (body.height === undefined && body.weight === undefined) {
    return Response.json(
      { error: 'At least one of height or weight is required.' },
      { status: 400 }
    );
  }

  const updated = await updateCreatorProfile(userId, {
    height: body.height,
    weight: body.weight,
  });

  // Return 404 if no creator exists for this user
  if (!updated) {
    return new Response('Creator not found', { status: 404 });
  }

  return Response.json(updated);
}
