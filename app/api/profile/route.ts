import { auth } from '@clerk/nextjs/server';
import { createCreatorIfNotExists, updateCreatorProfile } from '@/db/repositories/creators';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  // Provision lazily -- see the note in app/api/jobs/route.ts. The Clerk webhook
  // is an optimization, not the only path that creates a creator row.
  const creator = await createCreatorIfNotExists(userId);
  return Response.json(creator);
}

export async function PATCH(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const body = await req.json();

  // Validate that at least one field is provided
  const AUDIENCES = ['mens', 'womens', 'any'];
  if (body.audience !== undefined && !AUDIENCES.includes(body.audience)) {
    return Response.json({ error: 'Audience must be mens, womens, or any.' }, { status: 400 });
  }

  if (body.height === undefined && body.weight === undefined && body.audience === undefined) {
    return Response.json(
      { error: 'At least one of height, weight or audience is required.' },
      { status: 400 }
    );
  }

  // Same lazy provisioning as GET, so a save works even if the client never
  // loaded the profile first (e.g. the Clerk webhook never fired).
  await createCreatorIfNotExists(userId);

  const updated = await updateCreatorProfile(userId, {
    height: body.height,
    weight: body.weight,
    audience: body.audience,
  });

  // Return 404 if no creator exists for this user
  if (!updated) {
    return new Response('Creator not found', { status: 404 });
  }

  return Response.json(updated);
}
