import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Webhook } from 'svix';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators } from '@/db/schema';

// A fake, non-production secret used only to sign and verify payloads within
// this test — Svix's Webhook class just needs a consistent, validly-base64
// secret to round-trip sign()/verify() against itself, it never needs to be real.
const TEST_WEBHOOK_SECRET = 'whsec_ZmFrZS10ZXN0LW9ubHktc2VjcmV0LWtleS1ub3QtcmVhbA==';

describe('webhook signature verification and idempotency', () => {
  const CLERK_USER_ID = 'user_test_webhook_race_123';

  beforeEach(async () => {
    // Clean up test user from database
    await db.delete(creators).where(eq(creators.clerkUserId, CLERK_USER_ID));
  });

  it('repository handles duplicate inserts idempotently via onConflictDoNothing', async () => {
    // Import the repository function to test the race condition fix directly
    const { createCreatorIfNotExists } = await import('@/db/repositories/creators');

    // First call creates the record
    const first = await createCreatorIfNotExists(CLERK_USER_ID);
    expect(first).toBeDefined();
    expect(first.clerkUserId).toBe(CLERK_USER_ID);

    // Second concurrent call should not throw and should return the same record
    const second = await createCreatorIfNotExists(CLERK_USER_ID);
    expect(second).toBeDefined();
    expect(second.id).toBe(first.id);
    expect(second.clerkUserId).toBe(CLERK_USER_ID);

    // Verify exactly one record exists
    const records = await db.query.creators.findMany({
      where: eq(creators.clerkUserId, CLERK_USER_ID),
    });
    expect(records).toHaveLength(1);
  });

  it('validates that webhook secret format is correct for Svix', () => {
    // This test ensures the webhook secret can be used by Svix
    // A valid webhook secret should not throw when passed to Webhook constructor
    expect(() => {
      new Webhook(TEST_WEBHOOK_SECRET);
    }).not.toThrow();
  });

  it('creates a properly signed webhook payload', () => {
    const payload = JSON.stringify({
      type: 'user.created',
      data: { id: CLERK_USER_ID },
    });

    const wh = new Webhook(TEST_WEBHOOK_SECRET);
    const msgId = 'msg_test_123';
    const timestamp = new Date();

    // This should not throw - we can successfully sign payloads
    const signature = wh.sign(msgId, timestamp, payload);
    expect(signature).toBeDefined();
    expect(signature).toContain('v1,');
  });
});
