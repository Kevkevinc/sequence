import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators, jobs, styles, jobInspirationImages } from '@/db/schema';
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

describe('createJob with a style', () => {
  const CLERK_ID = 'test_clerk_user_jobs_style';
  let styleId: string;

  beforeEach(async () => {
    // Delete any existing test style to prevent orphan rows in the shared dev database.
    // Since there are FK constraints without cascade delete, delete in dependency order:
    // jobInspirationImages -> jobs -> styles
    const existingStyle = await db.query.styles.findFirst({
      where: eq(styles.name, 'Test Repo Job Style'),
    });
    if (existingStyle) {
      const styleJobs = await db.query.jobs.findMany({
        where: eq(jobs.styleId, existingStyle.id),
      });
      for (const job of styleJobs) {
        await db.delete(jobInspirationImages).where(eq(jobInspirationImages.jobId, job.id));
      }
      await db.delete(jobs).where(eq(jobs.styleId, existingStyle.id));
      await db.delete(styles).where(eq(styles.id, existingStyle.id));
    }

    const [style] = await db
      .insert(styles)
      .values({
        name: 'Test Repo Job Style',
        description: 'For repository tests',
        config: {
          cutMinSeconds: 2,
          cutMaxSeconds: 5,
          hookStyleLibrary: ['x'],
          variesClipOrder: true,
          usesInspirationOverlay: true,
        },
      })
      .returning();
    styleId = style.id;
  });

  it('creates a job with a styleId and no pacing, plus an inspiration image', async () => {
    const creator = await createCreatorIfNotExists(CLERK_ID);
    const job = await createJob({
      creatorId: creator.id,
      productName: 'Styled Product',
      sizingOverlayEnabled: false,
      lengthSeconds: 30,
      styleId,
      variationCount: 3,
      clips: [],
      inspirationImage: { storageKey: 'inspiration/test.jpg' },
    });

    expect(job.pacing).toBeNull();
    expect(job.styleId).toBe(styleId);

    const [image] = await db
      .select()
      .from(jobInspirationImages)
      .where(eq(jobInspirationImages.jobId, job.id));
    expect(image.storageKey).toBe('inspiration/test.jpg');
  });

  afterAll(async () => {
    // Clean up the test style and any dependent jobs to prevent orphan rows in the shared dev database.
    // Delete in dependency order: jobInspirationImages -> jobs -> styles
    const existingStyle = await db.query.styles.findFirst({
      where: eq(styles.name, 'Test Repo Job Style'),
    });
    if (existingStyle) {
      const styleJobs = await db.query.jobs.findMany({
        where: eq(jobs.styleId, existingStyle.id),
      });
      for (const job of styleJobs) {
        await db.delete(jobInspirationImages).where(eq(jobInspirationImages.jobId, job.id));
      }
      await db.delete(jobs).where(eq(jobs.styleId, existingStyle.id));
      await db.delete(styles).where(eq(styles.id, existingStyle.id));
    }
  });
});
