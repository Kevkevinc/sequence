import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobInspirationImages } from '@/db/schema';

/**
 * Every inspiration image for a job, in the order they should appear.
 *
 * The Fit Inspo format shows several in rapid succession, so this returns all
 * of them. Dupe Flip only ever uses the first, which is why
 * {@link getInspirationImageForJob} still exists rather than every caller
 * learning to index.
 */
export async function listInspirationImagesForJob(jobId: string) {
  return db
    .select()
    .from(jobInspirationImages)
    .where(eq(jobInspirationImages.jobId, jobId))
    .orderBy(asc(jobInspirationImages.position), asc(jobInspirationImages.createdAt));
}

export async function getInspirationImageForJob(jobId: string) {
  const [first] = await listInspirationImagesForJob(jobId);
  return first;
}
