import { headers } from 'next/headers';
import { Webhook } from 'svix';
import { getRequiredEnv } from '@/lib/env';
import { createCreatorIfNotExists } from '@/db/repositories/creators';

export async function POST(req: Request) {
  const payload = await req.text();
  const headerPayload = await headers();
  const svixHeaders = {
    'svix-id': headerPayload.get('svix-id') ?? '',
    'svix-timestamp': headerPayload.get('svix-timestamp') ?? '',
    'svix-signature': headerPayload.get('svix-signature') ?? '',
  };

  const wh = new Webhook(getRequiredEnv('CLERK_WEBHOOK_SECRET'));
  let event: { type: string; data: { id: string } };
  try {
    event = wh.verify(payload, svixHeaders) as typeof event;
  } catch (error) {
    console.error(
      '[Clerk Webhook] Signature verification failed:',
      error instanceof Error ? error.message : String(error)
    );
    return new Response('Invalid signature', { status: 400 });
  }

  if (event.type === 'user.created') {
    try {
      await createCreatorIfNotExists(event.data.id);
    } catch (error) {
      console.error(
        '[Clerk Webhook] Failed to create creator for user:',
        event.data.id,
        error instanceof Error ? error.message : String(error)
      );
      return new Response('Internal server error', { status: 500 });
    }
  }

  return new Response('ok', { status: 200 });
}
