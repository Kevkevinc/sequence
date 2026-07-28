import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators } from '@/db/schema';

export async function createCreatorIfNotExists(clerkUserId: string) {
  const existing = await db.query.creators.findFirst({
    where: eq(creators.clerkUserId, clerkUserId),
  });
  if (existing) return existing;

  const [created] = await db.insert(creators).values({ clerkUserId }).returning();
  return created;
}

export async function getCreatorByClerkId(clerkUserId: string) {
  return db.query.creators.findFirst({
    where: eq(creators.clerkUserId, clerkUserId),
  });
}
