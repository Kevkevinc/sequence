import { writeFile } from 'fs/promises';
import path from 'path';
import { buildAssFile } from '@/lib/render/captions';
import { measureChannelBalance } from '@/lib/render/normalise';
import { buildTalkingHeadArgs } from '@/lib/render/talkingHeadArgs';
import { probeDuration, runFfmpeg } from '@/lib/render/ffmpeg';
import { DEFAULT_PROFILE, type QualityProfile } from '@/lib/render/frame';
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
 * The whole edit is rendered in a single ffmpeg pass — every run trimmed,
 * reframed and cleaned, joined with the concat filter, and the captions burned
 * over the join — so the picture is compressed exactly once. The older shape
 * encoded each run to an intermediate and re-encoded the join to add text,
 * which spent a second generation of compression on detail phone footage can
 * least afford to lose. See {@link buildTalkingHeadArgs}.
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
  /** Output resolution and CRF. Defaults to 1080p. */
  profile?: QualityProfile;
}): Promise<TalkingRenderResult> {
  const captions = input.captionSettings ?? DEFAULT_CAPTION_SETTINGS;
  const profile = input.profile ?? DEFAULT_PROFILE;

  if (input.runs.length === 0) {
    return {
      success: false,
      error: 'No speech was found in this recording, so there is nothing to cut.',
    };
  }

  // Measured once on the whole recording, so every cut is treated identically —
  // a per-cut measurement could classify two cuts of one take differently and
  // shift the background audibly at a splice.
  const channelBalance = await measureChannelBalance(input.sourcePath);

  const assPath = path.join(input.workingDir, 'captions.ass');
  await writeFile(
    assPath,
    buildAssFile(shiftCuesToEditedTimeline(input.cues, input.runs), captions, {
      position: input.captionPosition,
      profile,
    }),
    'utf8'
  );

  const fontsDir = path.join(process.cwd(), 'assets', 'fonts');
  const rendered = await runFfmpeg(
    buildTalkingHeadArgs({
      sourcePath: input.sourcePath,
      runs: input.runs,
      assPath,
      fontsDir,
      outputPath: input.outputPath,
      channelBalance,
      profile,
    })
  );
  if (!rendered.success) {
    return { success: false, error: `Failed to render the talking-head edit: ${rendered.error}` };
  }

  return {
    success: true,
    outputPath: input.outputPath,
    durationSeconds: await probeDuration(input.outputPath),
  };
}
