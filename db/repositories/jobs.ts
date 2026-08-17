import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips, jobInspirationImages } from '@/db/schema';
import type { CaptionSettings } from '@/lib/render/captionSettings';

export type CreateJobInput = {
  creatorId: string;
  productName: string;
  sizeWorn?: string;
  sizingOverlayEnabled: boolean;
  lengthSeconds: 15 | 30 | 45 | 60;
  pacing?: 'slow' | 'medium' | 'fast';
  styleId?: string;
  variationCount: number;
  /**
   * Caption look chosen for this job specifically.
   *
   * Undefined is the normal case and is stored as null, meaning "keep
   * inheriting from the style or the profile" — freezing today's inherited
   * values into the row would silently detach the job from a look the creator
   * later changes.
   */
  captionSettings?: CaptionSettings;
  /** Which editor runs this job. Defaults to the original silent pipeline. */
  kind?: 'cuts' | 'talking';
  /** Output resolution. Defaults to 1080p. */
  quality?: '1080p' | '4k';
  clips: { storageKey: string; originalFilename: string }[];
  inspirationImage?: { storageKey: string };
  /**
   * Fit Inspo intro images, in the order they should appear. Separate from
   * `inspirationImage` because the two styles treat their uploads differently
   * and a job only ever uses one of them.
   */
  inspirationImages?: { storageKey: string; kind: 'person' | 'listing' }[];
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
        captionSettings: input.captionSettings ?? null,
        kind: input.kind ?? 'cuts',
        quality: input.quality ?? '1080p',
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

    if (input.inspirationImages?.length) {
      // `position` is the array order: the creator arranged them, and the
      // intro plays them in that order.
      await tx.insert(jobInspirationImages).values(
        input.inspirationImages.map((image, index) => ({
          jobId: job.id,
          storageKey: image.storageKey,
          kind: image.kind,
          position: index,
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
