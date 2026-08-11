import webpush from 'web-push';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { pushSubscriptions } from '@/db/schema';

/**
 * Sends "your videos are ready" to a creator's phone.
 *
 * The point of this whole feature: a render takes ten to fifteen minutes, which
 * is far longer than anyone watches a progress bar. Without a way to reach
 * them, a creator starts a job, closes the app, and finds out tomorrow — or
 * forgets they signed up. This is the only channel the product has to them.
 *
 * Every failure here is swallowed. A notification is a courtesy on top of work
 * that has already succeeded and been stored; turning "we could not buzz your
 * phone" into "your job failed" would be an absurd trade.
 */

let configured: boolean | null = null;

/**
 * Loads the signing keys, once.
 *
 * These prove a push genuinely came from this server. Without them the push
 * services reject everything, so an unconfigured deployment simply does not
 * notify rather than erroring on every completed job — which is the right
 * behaviour for a feature that is additive.
 */
function ready(): boolean {
  if (configured !== null) return configured;

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const contact = process.env.VAPID_CONTACT_EMAIL ?? 'mailto:support@example.com';

  if (!publicKey || !privateKey) {
    console.warn('Push notifications are not configured (VAPID keys missing); skipping.');
    configured = false;
    return false;
  }

  webpush.setVapidDetails(contact, publicKey, privateKey);
  configured = true;
  return true;
}

export type PushMessage = {
  title: string;
  body: string;
  /** Where tapping the notification should land. */
  url?: string;
  /** Collapses repeats about the same thing into one notification. */
  tag?: string;
};

/**
 * Delivers to every device a creator has allowed.
 *
 * Devices that the push service reports as gone are deleted rather than
 * retried. Subscriptions expire constantly — a wiped phone, a removed app, a
 * browser that cleared its storage — and keeping them would mean a growing
 * table of addresses that can never receive anything.
 */
export async function notifyCreator(creatorId: string, message: PushMessage): Promise<number> {
  if (!ready()) return 0;

  try {
    const devices = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.creatorId, creatorId));
    if (devices.length === 0) return 0;

    const payload = JSON.stringify(message);
    const dead: string[] = [];
    let delivered = 0;

    await Promise.all(
      devices.map(async (device) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: device.endpoint,
              keys: { p256dh: device.p256dh, auth: device.auth },
            },
            payload
          );
          delivered += 1;
        } catch (error) {
          // 404/410 mean the push service has permanently dropped this device.
          const statusCode = (error as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) dead.push(device.id);
          else {
            console.warn(
              `Push to one device failed (${statusCode ?? 'unknown'}): ` +
                `${error instanceof Error ? error.message : error}`
            );
          }
        }
      })
    );

    if (dead.length > 0) {
      await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, dead));
    }

    return delivered;
  } catch (error) {
    console.warn(
      `Could not send push notifications: ${error instanceof Error ? error.message : error}`
    );
    return 0;
  }
}

/** Wording for a finished job, kept here so the worker does not compose copy. */
export function jobFinishedMessage(input: {
  productName: string;
  videoCount: number;
  jobId: string;
}): PushMessage {
  const { productName, videoCount, jobId } = input;
  return {
    title: videoCount === 1 ? 'Your video is ready' : `Your ${videoCount} videos are ready`,
    body: `"${productName.trim()}" is done. Tap to download.`,
    url: `/jobs/${jobId}`,
    // One notification per job, however many times this is called for it.
    tag: `job-${jobId}`,
  };
}
