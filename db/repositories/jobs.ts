import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips, jobInspirationImages } from '@/db/schema';

export type CreateJobInput = {
  creatorId: string;
  productName: string;
  sizeWorn?: string;
  sizingOverlayEnabled: boolean;
  lengthSeconds: 15 | 30 | 45 | 60;
  pacing?: 'slow' | 'medium' | 'fast';
  styleId?: string;
  variationCount: number;
  clips: { storageKey: string; originalFilename: string }[];
  inspirationImage?: { storageKey: string };
};

export async function createJob(input: CreateJobInput) {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .insert(jobs)
      .values({
        creatorId: input.creatorId,
        productName: input.productName,
        sizeWorn: input.sizeWorn,
        sizingOverlayEnabled: input.sizingOverlayEnabled,
        lengthSeconds: input.lengthSeconds,
        pacing: input.pacing,
        styleId: input.styleId,
        variationCount: input.variationCount,
      })
      .returning();

    if (input.clips.length > 0) {
      await tx.insert(rawClips).values(
        input.clips.map((clip) => ({
          jobId: job.id,
          storageKey: clip.storageKey,
          originalFilename: clip.originalFilename,
        }))
      );
    }

    if (input.inspirationImage) {
      await tx.insert(jobInspirationImages).values({
        jobId: job.id,
        storageKey: input.inspirationImage.storageKey,
      });
    }

    return job;
  });
}

export async function listJobsForCreator(creatorId: string) {
  return db.query.jobs.findMany({
    where: eq(jobs.creatorId, creatorId),
    orderBy: desc(jobs.createdAt),
  });
}

/**
 * A single job, scoped to its owner. Returns `undefined` for a job that
 * either does not exist or belongs to someone else — deliberately the same
 * outcome for both, so a detail route can return one plain 404 rather than
 * distinguishing "not found" from "not yours" and leaking which jobs exist.
 */
export async function getJobForCreator(jobId: string, creatorId: string) {
  return db.query.jobs.findFirst({
    where: and(eq(jobs.id, jobId), eq(jobs.creatorId, creatorId)),
  });
}
