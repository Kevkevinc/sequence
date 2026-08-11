import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { concatCuts } from '@/lib/render/concat';
import { buildAssFile, escapeFilterPath } from '@/lib/render/captions';
import { normaliseCut } from '@/lib/render/normalise';
import { probeDuration, runFfmpeg } from '@/lib/render/ffmpeg';
import { DEFAULT_CAPTION_SETTINGS, type CaptionSettings } from '@/lib/render/captionSettings';
import type { CaptionCue } from '@/lib/pipeline/align';
import type { SpeechRun } from '@/lib/pipeline/speech';

/**
 * Renders a talking-head edit: the speech, tightened, with its audio intact and
 * captions burned on.
 *
 * A separate path from the silent renderer rather than a flag through it. The
 * two disagree on nearly everything that matters — one re-sequences cuts freely
 * and throws audio away, the other must keep every cut in the order it was
 * spoken and carry the audio in sync — and threading that through one function
 * would leave both harder to reason about than either is now.
 *
 * The shape is deliberately the same, though: cut the parts, stream-copy them
 * together, then one final pass for text and the delivery encode. That is the
 * arrangement the silent path already proved out, including keeping peak disk
 * down by dropping the parts as soon as they are joined.
 */

export type TalkingRenderResult =
  | { success: true; outputPath: string; durationSeconds: number }
  | { success: false; error: string };

/**
 * Maps caption times from the original recording onto the finished edit.
 *
 * Cues are timed against the source, but the render removes the pauses between
 * runs — so a cue at 12s in the recording may be at 7s in the export. Without
 * this every caption after the first cut drifts later and later, by exactly the
 * amount of silence removed before it.
 */
export function shiftCuesToEditedTimeline(
  cues: CaptionCue[],
  runs: SpeechRun[]
): CaptionCue[] {
  const shifted: CaptionCue[] = [];
  let elapsed = 0;

  for (const run of runs) {
    const length = run.endSeconds - run.startSeconds;
    for (const cue of cues) {
      // A cue belongs to the run its start falls in; `buildCaptionCues`
      // guarantees a cue never spans two runs, so this cannot split one.
      if (cue.startSeconds < run.startSeconds - 1e-6 || cue.startSeconds > run.endSeconds + 1e-6) {
        continue;
      }
      const start = elapsed + (cue.startSeconds - run.startSeconds);
      const end = elapsed + Math.min(cue.endSeconds - run.startSeconds, length);
      shifted.push({ text: cue.text, startSeconds: start, endSeconds: Math.max(end, start + 0.05) });
    }
    elapsed += length;
  }

  return shifted.sort((a, b) => a.startSeconds - b.startSeconds);
}

export async function renderTalkingHead(input: {
  sourcePath: string;
  runs: SpeechRun[];
  cues: CaptionCue[];
  workingDir: string;
  outputPath: string;
  captionSettings?: CaptionSettings;
  /** Where captions sit, as fractions of the frame. Low by default, clear of the face. */
  captionPosition?: { x: number; y: number };
}): Promise<TalkingRenderResult> {
  const captions = input.captionSettings ?? DEFAULT_CAPTION_SETTINGS;

  if (input.runs.length === 0) {
    return {
      success: false,
      error: 'No speech was found in this recording, so there is nothing to cut.',
    };
  }

  const cutsDir = path.join(input.workingDir, 'talking-cuts');
  await mkdir(cutsDir, { recursive: true });

  const parts: string[] = [];
  for (const [index, run] of input.runs.entries()) {
    const partPath = path.join(cutsDir, `part-${String(index).padStart(3, '0')}.mp4`);
    const result = await normaliseCut({
      sourcePath: input.sourcePath,
      startSeconds: run.startSeconds,
      endSeconds: run.endSeconds,
      outputPath: partPath,
      keepAudio: true,
    });
    if (!result.success) {
      return {
        success: false,
        error: `Failed to cut speech section ${index + 1}/${input.runs.length}: ${result.error}`,
      };
    }
    parts.push(partPath);
  }

  const joinedPath = path.join(input.workingDir, 'talking-joined.mp4');
  const joined = await concatCuts(parts, joinedPath);
  if (!joined.success) {
    return { success: false, error: `Failed to join the speech sections: ${joined.error}` };
  }

  const assPath = path.join(input.workingDir, 'captions.ass');
  await writeFile(
    assPath,
    buildAssFile(shiftCuesToEditedTimeline(input.cues, input.runs), captions, {
      position: input.captionPosition,
    }),
    'utf8'
  );

  /*
   * Video is re-encoded to burn the captions in; audio is copied.
   *
   * The parts were already encoded to the delivery audio format, so re-encoding
   * here would be a second generation of lossy audio for no gain — and on a
   * talking video the audio *is* the content.
   */
  const fontsDir = path.join(process.cwd(), 'assets', 'fonts');
  const burned = await runFfmpeg([
    '-i', joinedPath,
    '-vf', `subtitles='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDir)}'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '13',
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-color_range', 'tv',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    input.outputPath,
  ]);
  if (!burned.success) {
    return { success: false, error: `Failed to burn in the captions: ${burned.error}` };
  }

  return {
    success: true,
    outputPath: input.outputPath,
    durationSeconds: await probeDuration(input.outputPath),
  };
}
