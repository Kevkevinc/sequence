import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { z } from 'zod';
import { inArray, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { editPlans, rawClips, jobs, styles } from '@/db/schema';
import {
  downloadClipToTempFile,
  uploadRenderThumbnail,
  uploadRenderedVideo,
  type LocalClip,
} from '@/lib/storage';
import {
  getInspirationImageForJob,
  listInspirationImagesForJob,
} from '@/db/repositories/jobInspirationImages';
import {
  prepareFitInspoLayers,
  type FitInspoLayer,
  type FitInspoSource,
} from '@/lib/render/fitInspo';
import { normaliseCut } from '@/lib/render/normalise';
import { concatCuts } from '@/lib/render/concat';
import { overlayText } from '@/lib/render/text';
import { probeDuration, runFfmpeg } from '@/lib/render/ffmpeg';
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
    let fitInspoLayers: FitInspoLayer[] = [];
    // Collected here, turned into cutouts further down: generating them needs
    // the render's temp directory, which does not exist until the clips are
    // about to be cut.
    const fitInspoSources: FitInspoSource[] = [];
    if (job.styleId) {
      const [styleRow] = await db.select().from(styles).where(eq(styles.id, job.styleId));
      // Unlike the director (a dangling/malformed style there is a hard
      // failure — see `planJob`), a style that can't be resolved at render
      // time is a cosmetic-only degrade: default white text and no
      // inspiration photo still produce a usable video. Failing the whole
      // render over that would be worse than the degrade itself. But it must
      // not be a *silent* degrade, so the same `jobs.warning` column the
      // director uses for short-footage notices carries this one too.
      let styleWarning: string | undefined;
      if (!styleRow) {
        styleWarning =
          "This video's style could not be found, so it rendered with default text color and no inspiration photo.";
      } else {
        const parsed = StyleConfigSchema.safeParse(styleRow.config);
        if (!parsed.success) {
          styleWarning =
            "This video's style has an invalid configuration, so it rendered with default text color and no inspiration photo.";
        } else {
          textColor = parsed.data.textColor;
          if (parsed.data.usesInspirationOverlay) {
            const inspirationImage = await getInspirationImageForJob(plan.jobId);
            if (inspirationImage) {
              inspirationImageClip = await downloadClipToTempFile(inspirationImage.storageKey);
              downloadedClips.push(inspirationImageClip); // reuses the existing cleanup loop
            }
          }

          if (parsed.data.usesFitInspoIntro) {
            for (const image of await listInspirationImagesForJob(plan.jobId)) {
              const clip = await downloadClipToTempFile(image.storageKey);
              downloadedClips.push(clip); // reuses the existing cleanup loop
              fitInspoSources.push({ path: clip.path, kind: image.kind });
            }
          }
        }
      }

      if (styleWarning) {
        await db.update(jobs).set({ warning: styleWarning }).where(eq(jobs.id, job.id));
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
    if (fitInspoSources.length > 0) {
      // Cutting backgrounds out is the slowest single step in a render (~3s an
      // image). Best effort, like everything else derived from the style here:
      // a failure costs the intro, not the whole video.
      try {
        fitInspoLayers = await prepareFitInspoLayers(fitInspoSources, tempDir);
      } catch (error) {
        console.warn(
          `Render ${plan.id}: Fit Inspo intro failed, rendering without it: ` +
            `${error instanceof Error ? error.message : error}`
        );
      }
    }

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
      fitInspoLayers,
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

    // A still frame for list thumbnails. Best effort on purpose: the video is
    // already uploaded and watchable, so a thumbnail that fails to generate is
    // a missing poster (the UI falls back to a placeholder), not a failed
    // render the creator has to redo.
    const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');
    const thumbnailResult = await runFfmpeg([
      '-ss', '0.6',
      '-i', finalPath,
      '-frames:v', '1',
      '-q:v', '4',
      '-update', '1',
      thumbnailPath,
    ]);
    if (thumbnailResult.success) {
      const thumbUpload = await uploadRenderThumbnail(thumbnailPath, storageKey);
      if (!thumbUpload.success) {
        console.warn(`Render ${storageKey}: thumbnail upload failed: ${thumbUpload.error}`);
      }
    } else {
      console.warn(`Render ${storageKey}: thumbnail extraction failed: ${thumbnailResult.error}`);
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
