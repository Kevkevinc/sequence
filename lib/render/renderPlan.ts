import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { z } from 'zod';
import { inArray, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { editPlans, rawClips, jobs, styles } from '@/db/schema';
import { downloadClipToTempFile, uploadRenderedVideo, type LocalClip } from '@/lib/storage';
import { getInspirationImageForJob } from '@/db/repositories/jobInspirationImages';
import { normaliseCut } from '@/lib/render/normalise';
import { concatCuts } from '@/lib/render/concat';
import { overlayText } from '@/lib/render/text';
import { probeDuration } from '@/lib/render/ffmpeg';
import type { OverlayPlacement } from '@/lib/editPlan';
import { StyleConfigSchema } from '@/lib/styles';

/**
 * The shape `editPlans.segments` was written in by the director step. The
 * column is `jsonb` with no schema attached at the database level, so this is
 * re-validated on the way out rather than trusted — the same discipline the
 * director already applies to what it reads back from Gemini.
 */
const StoredSegmentSchema = z.object({
  rawClipId: z.uuid(),
  startSeconds: z.number(),
  endSeconds: z.number(),
});
const StoredSegmentsSchema = z.array(StoredSegmentSchema).min(1);

export type RenderPlanResult =
  | { success: true; storageKey: string; durationSeconds: number }
  | { success: false; error: string };

/**
 * Turns one EditPlan into a finished, uploaded MP4.
 *
 * Sequence: load the plan → download each *distinct* source clip once (a plan
 * routinely cuts the same clip several times, and downloading per-cut would
 * re-fetch the same tens-of-megabytes file repeatedly) → normalise every cut
 * to the shared format → concatenate → burn in the hook and sizing text →
 * upload → report the storage key and the video's real, measured length.
 *
 * Records nothing to the database — the caller owns the `renders` row, which
 * keeps this function testable without a render already existing to update.
 * Never throws; every failure path returns the documented result instead, so
 * a bad plan or a missing clip fails this one render rather than the worker.
 */
export async function renderPlan(editPlanId: string): Promise<RenderPlanResult> {
  let tempDir: string | undefined;
  const downloadedClips: LocalClip[] = [];

  try {
    const [plan] = await db.select().from(editPlans).where(eq(editPlans.id, editPlanId));
    if (!plan) {
      return { success: false, error: `Edit plan ${editPlanId} not found` };
    }

    const [job] = await db.select().from(jobs).where(eq(jobs.id, plan.jobId));
    if (!job) {
      return { success: false, error: `Job ${plan.jobId} for edit plan ${editPlanId} was not found` };
    }

    let textColor: string | undefined;
    let inspirationImageClip: LocalClip | undefined;
    if (job.styleId) {
      const [styleRow] = await db.select().from(styles).where(eq(styles.id, job.styleId));
      if (styleRow) {
        const parsed = StyleConfigSchema.safeParse(styleRow.config);
        if (parsed.success) {
          textColor = parsed.data.textColor;
          if (parsed.data.usesInspirationOverlay) {
            const inspirationImage = await getInspirationImageForJob(plan.jobId);
            if (inspirationImage) {
              inspirationImageClip = await downloadClipToTempFile(inspirationImage.storageKey);
              downloadedClips.push(inspirationImageClip); // reuses the existing cleanup loop
            }
          }
        }
      }
    }

    const parsedSegments = StoredSegmentsSchema.safeParse(plan.segments);
    if (!parsedSegments.success) {
      return {
        success: false,
        error: `Edit plan ${editPlanId} has malformed segments: ${parsedSegments.error.message}`,
      };
    }
    const segments = parsedSegments.data;

    const distinctClipIds = [...new Set(segments.map((s) => s.rawClipId))];
    const clips = await db.select().from(rawClips).where(inArray(rawClips.id, distinctClipIds));
    const storageKeyByClipId = new Map(clips.map((c) => [c.id, c.storageKey]));

    const missing = distinctClipIds.filter((id) => !storageKeyByClipId.has(id));
    if (missing.length > 0) {
      return {
        success: false,
        error: `Edit plan ${editPlanId} references raw clips that no longer exist: ${missing.join(', ')}`,
      };
    }

    tempDir = await mkdtemp(path.join(tmpdir(), 'ugc-render-'));
    const cutsDir = path.join(tempDir, 'cuts');
    await mkdir(cutsDir);

    // Download once per distinct clip, not once per cut.
    const localPathByClipId = new Map<string, string>();
    for (const clipId of distinctClipIds) {
      const storageKey = storageKeyByClipId.get(clipId)!;
      const local = await downloadClipToTempFile(storageKey);
      downloadedClips.push(local);
      localPathByClipId.set(clipId, local.path);
    }

    // Normalise every cut, in the plan's order, so concatenation can be a
    // straight stream copy.
    const partPaths: string[] = [];
    for (const [index, segment] of segments.entries()) {
      const partPath = path.join(cutsDir, `part-${String(index).padStart(3, '0')}.mp4`);
      const result = await normaliseCut({
        sourcePath: localPathByClipId.get(segment.rawClipId)!,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        outputPath: partPath,
      });
      if (!result.success) {
        return {
          success: false,
          error: `Failed to render cut ${index + 1}/${segments.length}: ${result.error}`,
        };
      }
      partPaths.push(partPath);
    }

    const concatPath = path.join(tempDir, 'concat.mp4');
    const concatResult = await concatCuts(partPaths, concatPath);
    if (!concatResult.success) {
      return { success: false, error: `Failed to join cuts: ${concatResult.error}` };
    }

    const finalPath = path.join(tempDir, 'final.mp4');
    const textResult = await overlayText({
      sourcePath: concatPath,
      outputPath: finalPath,
      hookText: plan.hookText,
      sizing: plan.sizingOverlayText
        ? {
            text: plan.sizingOverlayText,
            placement: (plan.sizingOverlayPlacement ?? 'bottom-left') as OverlayPlacement,
          }
        : null,
      tempDir,
      textColor,
      inspirationImagePath: inspirationImageClip?.path,
    });
    if (!textResult.success) {
      return { success: false, error: `Failed to add on-screen text: ${textResult.error}` };
    }

    const durationSeconds = await probeDuration(finalPath);

    const storageKey = `renders/${randomUUID()}.mp4`;
    const uploadResult = await uploadRenderedVideo(finalPath, storageKey);
    if (!uploadResult.success) {
      return { success: false, error: `Failed to upload the rendered video: ${uploadResult.error}` };
    }

    return { success: true, storageKey, durationSeconds };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    for (const clip of downloadedClips) {
      await clip.cleanUp();
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
