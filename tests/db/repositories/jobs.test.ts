import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators, jobs } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob, listJobsForCreator } from '@/db/repositories/jobs';

describe('listJobsForCreator', () => {
  const CLERK_ID = 'test_clerk_user_jobs';

  beforeEach(async () => {
    const existing = await db.query.creators.findFirst({
      where: eq(creators.clerkUserId, CLERK_ID),
    });
    if (existing) {
      // Jobs reference creators via a foreign key, so they must be deleted
      // first or the creator delete below violates the FK constraint.
      await db.delete(jobs).where(eq(jobs.creatorId, existing.id));
      await db.delete(creators).where(eq(creators.id, existing.id));
    }
  });

  it('returns jobs belonging to the given creator, most recent first', async () => {
    const creator = await createCreatorIfNotExists(CLERK_ID);

    await createJob({
      creatorId: creator.id,
      productName: 'First Product',
      sizingOverlayEnabled: false,
      lengthSeconds: 30,
      pacing: 'medium',
      variationCount: 3,
      clips: [],
    });
    await createJob({
      creatorId: creator.id,
      productName: 'Second Product',
      sizingOverlayEnabled: false,
      lengthSeconds: 15,
      pacing: 'fast',
      variationCount: 5,
      clips: [],
    });

    const result = await listJobsForCreator(creator.id);

    expect(result).toHaveLength(2);
    expect(result[0].productName).toBe('Second Product');
    expect(result[1].productName).toBe('First Product');
  });
});
