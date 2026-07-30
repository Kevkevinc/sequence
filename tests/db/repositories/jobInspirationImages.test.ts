import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators, jobs, jobInspirationImages } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { getInspirationImageForJob } from '@/db/repositories/jobInspirationImages';

describe('getInspirationImageForJob', () => {
  const CLERK_ID = 'test_clerk_user_inspo_images';

  it('returns the storage key for a job with an inspiration image', async () => {
    const creator = await createCreatorIfNotExists(CLERK_ID);
    const job = await createJob({
      creatorId: creator.id,
      productName: 'Denim',
      sizingOverlayEnabled: false,
      lengthSeconds: 15,
      pacing: 'fast',
      variationCount: 1,
      clips: [],
      inspirationImage: { storageKey: 'inspiration/repo-test.jpg' },
    });

    const result = await getInspirationImageForJob(job.id);
    expect(result?.storageKey).toBe('inspiration/repo-test.jpg');
  });

  it('returns undefined for a job with no inspiration image', async () => {
    const creator = await createCreatorIfNotExists(CLERK_ID);
    const job = await createJob({
      creatorId: creator.id,
      productName: 'Denim',
      sizingOverlayEnabled: false,
      lengthSeconds: 15,
      pacing: 'fast',
      variationCount: 1,
      clips: [],
    });

    const result = await getInspirationImageForJob(job.id);
    expect(result).toBeUndefined();
  });
});
