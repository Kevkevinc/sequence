import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobInspirationImages } from '@/db/schema';

export async function getInspirationImageForJob(jobId: string) {
  return db.query.jobInspirationImages.findFirst({ where: eq(jobInspirationImages.jobId, jobId) });
}
