import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { pushSubscriptions } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';

/**
 * Registers a phone to receive "your videos are ready".
 *
 * The browser hands over an endpoint and two keys; all three are needed to
 * encrypt a message to that specific device, and none of them are secret to the
 * creator who owns them.
 */
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
  const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : '';
  const authKey = typeof body?.keys?.auth === 'string' ? body.keys.auth : '';

  if (!endpoint || !p256dh || !authKey) {
    return Response.json({ error: 'A complete push subscription is required.' }, { status: 400 });
  }

  const creator = await createCreatorIfNotExists(userId);

  /*
   * Keyed on the endpoint, which the push service issues per device.
   *
   * Re-subscribing is routine — browsers rotate these, and the client
   * re-registers on every load — so this has to update in place. Inserting
   * blindly would grow a table of duplicates for one phone, and every one of
   * them would deliver, so a creator would get the same notification five
   * times.
   *
   * The creator id is updated too: a shared or handed-down device should notify
   * whoever is signed in now, not whoever registered it first.
   */
  await db
    .insert(pushSubscriptions)
    .values({ creatorId: creator.id, endpoint, p256dh, auth: authKey })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { creatorId: creator.id, p256dh, auth: authKey },
    });

  return Response.json({ ok: true });
}

/** Forgets a device, so turning notifications off actually stops them. */
export async function DELETE(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  if (typeof body?.endpoint !== 'string' || !body.endpoint) {
    return Response.json({ error: 'An endpoint is required.' }, { status: 400 });
  }

  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, body.endpoint));
  return Response.json({ ok: true });
}
