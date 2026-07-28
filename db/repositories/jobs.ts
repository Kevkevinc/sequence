import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips } from '@/db/schema';

export type CreateJobInput = {
  creatorId: string;
  productName: string;
  sizeWorn?: string;
  sizingOverlayEnabled: boolean;
  lengthSeconds: 15 | 30 | 45 | 60;
  pacing: 'slow' | 'medium' | 'fast';
  variationCount: number;
  clips: { storageKey: string; originalFilename: string }[];
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

    return job;
  });
}

export async function listJobsForCreator(creatorId: string) {
  return db.query.jobs.findMany({
    where: eq(jobs.creatorId, creatorId),
    orderBy: desc(jobs.createdAt),
  });
}
