import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators } from '@/db/schema';
import { createCreatorIfNotExists, getCreatorByClerkId, updateCreatorProfile } from '@/db/repositories/creators';

describe('creator repository', () => {
  const CLERK_ID = 'test_clerk_user_1';

  beforeEach(async () => {
    await db.delete(creators).where(eq(creators.clerkUserId, CLERK_ID));
  });

  it('creates a new creator row for a first-time clerk user', async () => {
    const creator = await createCreatorIfNotExists(CLERK_ID);
    expect(creator.clerkUserId).toBe(CLERK_ID);

    const fetched = await getCreatorByClerkId(CLERK_ID);
    expect(fetched?.id).toBe(creator.id);
  });

  it('does not create a duplicate row when called twice for the same user', async () => {
    const first = await createCreatorIfNotExists(CLERK_ID);
    const second = await createCreatorIfNotExists(CLERK_ID);
    expect(second.id).toBe(first.id);
  });

  it('updates height and weight for an existing creator', async () => {
    await createCreatorIfNotExists(CLERK_ID);
    const updated = await updateCreatorProfile(CLERK_ID, { height: "5'6\"", weight: '135 lbs' });
    expect(updated.height).toBe("5'6\"");
    expect(updated.weight).toBe('135 lbs');
  });
});
