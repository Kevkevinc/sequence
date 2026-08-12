import { randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators, jobs, rawClips, styles } from '@/db/schema';
import { downloadClipToTempFile, uploadRenderThumbnail, uploadRenderedVideo } from '@/lib/storage';
import { alignWordsToRuns, buildCaptionCues, type CaptionCue } from '@/lib/pipeline/align';
import { transcribeClip, wordsOf } from '@/lib/pipeline/transcribe';
import { detectSpeechRuns, mergeShortGaps, padRuns } from '@/lib/pipeline/speech';
import { renderTalkingHead } from '@/lib/render/renderTalkingHead';
import { resolveCaptionSettings } from '@/lib/render/captionSettings';
import { THUMBNAIL } from '@/lib/render/renderPlan';
import { runFfmpeg } from '@/lib/render/ffmpeg';
import { StyleConfigSchema } from '@/lib/styles';

/**
 * The talking-head editor, end to end.
 *
 * One recording in, one tightened video out. There are no variations: the audio
 * fixes the order of the cuts, so "another edit of the same take" would either
 * be the same video or a differently-broken one.
 *
 * Order matters here. The audio is measured first and transcribed second, so a
 * recording with nobody speaking in it fails before it costs an API call.
 */

/** How the pauses are treated. Tuned for talking-to-camera, not for narration. */
export const TALKING_DEFAULTS = {
  /**
   * Pauses shorter than this are kept.
   *
   * Tuned down from 0.35 and then 0.25 on creator direction: pauses and gaps
   * should be minimised. 0.18s still sits above the gap between two words, so
   * speech is not chopped mid-phrase, but it no longer swallows the short beats
   * between sentences that a viewer reads as dead air.
   */
  keepGapSeconds: 0.18,
  /**
   * Restores the few milliseconds trimmed off a word's attack and tail.
   * Without it a cut clips the "p" off "perfect". Kept as small as that job
   * allows, because every millisecond of padding is a millisecond of the pause
   * put back.
   */
  padSeconds: 0.03,
  /**
   * Anything still shorter than this after padding is not cut at all.
   *
   * Padding expands both sides of every section, so a gap that was just long
   * enough to detect can end up a few hundredths of a second wide. A cut that
   * short is not an edit, it is a glitch — inaudible as a pause and visible as
   * a jump. This is the real guard against a choppy edit, which is what lets
   * the detection above run as close to the speech as it does.
   */
  minCutSeconds: 0.12,
  /**
   * Burned-in captions, off on creator direction.
   *
   * The machinery is kept and tested — measured word alignment, cue grouping
   * and an ASS track — because this is a presentation choice rather than a
   * dead end, and creators caption in TikTok itself where they can restyle it.
   *
   * Turning them off removes the only reason this editor talks to an AI at all:
   * the cuts come from measuring the audio, and the transcript existed solely
   * to caption it. A talking job now costs nothing per run.
   */
  captions: false,
  /** Where captions sit when they are on: low, clear of the speaker's face. */
  captionPosition: { x: 0.5, y: 0.76 },
};

export type TalkingHeadResult =
  | { success: true; storageKey: string; durationSeconds: number; removedSeconds: number }
  | { success: false; error: string };

export async function renderTalkingJob(jobId: string): Promise<TalkingHeadResult> {
  let workingDir: string | undefined;
  const cleanUps: Array<() => Promise<void>> = [];

  try {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job) return { success: false, error: `Job ${jobId} not found` };

    const clips = await db.select().from(rawClips).where(eq(rawClips.jobId, jobId));
    if (clips.length === 0) {
      return { success: false, error: 'This job has no recording to edit.' };
    }
    // One take per talking job. Multiple recordings would need a decision about
    // what order they belong in, which is a different feature (a multi-take
    // assembly) rather than a detail of this one.
    const clip = clips[0];

    const local = await downloadClipToTempFile(clip.storageKey);
    cleanUps.push(local.cleanUp);

    // Measured before anything is uploaded, so a silent recording costs nothing.
    const { runs: rawRuns, durationSeconds } = await detectSpeechRuns(local.path);
    if (rawRuns.length === 0) {
      return {
        success: false,
        error:
          'No speech was found in this recording. Talking mode needs a clip of you speaking to camera.',
      };
    }

    // Merged, padded, then merged again: the second pass drops cuts that
    // padding has shrunk below the point of being an edit at all.
    const runs = mergeShortGaps(
      padRuns(
        mergeShortGaps(rawRuns, TALKING_DEFAULTS.keepGapSeconds),
        TALKING_DEFAULTS.padSeconds,
        durationSeconds
      ),
      TALKING_DEFAULTS.minCutSeconds
    );

    /*
     * Transcribed only to caption. With captions off there is nothing to say
     * and nothing to pay for — the cuts were measured from the audio itself.
     *
     * A stored transcript is reused when it is needed, because re-rendering
     * after a tweak is expected and re-transcribing the same audio would charge
     * for the same answer twice.
     */
    let cues: CaptionCue[] = [];
    if (TALKING_DEFAULTS.captions) {
      let text = job.transcript ?? '';
      if (!text.trim()) {
        const transcribed = await transcribeClip(local.path);
        if (!transcribed.success) return { success: false, error: transcribed.error };
        text = transcribed.transcript.text;
        await db.update(jobs).set({ transcript: text }).where(eq(jobs.id, jobId));
      }
      cues = buildCaptionCues(alignWordsToRuns(wordsOf(text), runs), runs);
    }

    // Style mode takes the caption look from the style, Custom mode from the
    // creator's profile; a per-job tweak sits on top of either.
    let styleCaptions: unknown;
    if (job.styleId) {
      const [styleRow] = await db.select().from(styles).where(eq(styles.id, job.styleId));
      const parsed = styleRow ? StyleConfigSchema.safeParse(styleRow.config) : null;
      if (parsed?.success) styleCaptions = parsed.data.captionSettings;
    }
    const [creator] = await db.select().from(creators).where(eq(creators.id, job.creatorId));
    const captionSettings = resolveCaptionSettings(
      job.styleId ? styleCaptions : creator?.captionSettings,
      job.captionSettings
    );

    workingDir = await mkdtemp(path.join(tmpdir(), 'ugc-talking-'));
    const outputPath = path.join(workingDir, 'final.mp4');

    const rendered = await renderTalkingHead({
      sourcePath: local.path,
      runs,
      cues,
      workingDir,
      outputPath,
      captionSettings,
      captionPosition: TALKING_DEFAULTS.captionPosition,
    });
    if (!rendered.success) return { success: false, error: rendered.error };

    const storageKey = `renders/${randomUUID()}.mp4`;
    const uploaded = await uploadRenderedVideo(outputPath, storageKey);
    if (!uploaded.success) {
      return { success: false, error: `Failed to upload the finished video: ${uploaded.error}` };
    }

    // Best effort, exactly as in the silent path: a missing poster is a
    // placeholder in a list, not a failed render.
    const thumbnailPath = path.join(workingDir, 'thumbnail.jpg');
    const thumb = await runFfmpeg([
      '-ss', '0.6', '-i', outputPath, '-frames:v', '1',
      '-vf', `scale=${THUMBNAIL.width}:${THUMBNAIL.height}:flags=lanczos`,
      '-q:v', '4', '-update', '1', thumbnailPath,
    ]);
    if (thumb.success) {
      const upload = await uploadRenderThumbnail(thumbnailPath, storageKey);
      if (!upload.success) console.warn(`Talking render ${storageKey}: thumbnail upload failed`);
    }

    return {
      success: true,
      storageKey,
      durationSeconds: rendered.durationSeconds,
      removedSeconds: Math.max(0, durationSeconds - rendered.durationSeconds),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    for (const cleanUp of cleanUps) await cleanUp();
    if (workingDir) await rm(workingDir, { recursive: true, force: true }).catch(() => {});
  }
}
