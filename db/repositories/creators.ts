import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators } from '@/db/schema';

export async function createCreatorIfNotExists(clerkUserId: string) {
  const existing = await db.query.creators.findFirst({
    where: eq(creators.clerkUserId, clerkUserId),
  });
  if (existing) return existing;

  // Use onConflictDoNothing to handle race condition: if two concurrent calls
  // both see no existing creator, one will insert successfully and the other
  // will see the unique constraint and return nothing. We then re-fetch to
  // ensure idempotent behavior (duplicate webhook delivery gets the same
  // creator back instead of a 500 error).
  const result = await db
    .insert(creators)
    .values({ clerkUserId })
    .onConflictDoNothing()
    .returning();

  if (result.length > 0) {
    return result[0];
  }

  // We lost the race; re-fetch to get the creator that another request just inserted.
  const fetched = await db.query.creators.findFirst({
    where: eq(creators.clerkUserId, clerkUserId),
  });
  if (!fetched) {
    throw new Error(
      `Failed to create or retrieve creator for clerkUserId: ${clerkUserId}`
    );
  }
  return fetched;
}

export async function getCreatorByClerkId(clerkUserId: string) {
  return db.query.creators.findFirst({
    where: eq(creators.clerkUserId, clerkUserId),
  });
}

export async function updateCreatorProfile(
  clerkUserId: string,
  data: { height?: string; weight?: string }
) {
  const [updated] = await db
    .update(creators)
    .set(data)
    .where(eq(creators.clerkUserId, clerkUserId))
    .returning();
  return updated;
}
