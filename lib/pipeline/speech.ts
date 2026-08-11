import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

/**
 * Where somebody is actually talking, measured from the audio.
 *
 * This is the spine of the talking-head editor, and it is measured rather than
 * asked for on purpose. Gemini transcribes this project's audio perfectly but
 * its timestamps are inferred: against a synthesised track with known word
 * positions it drifted to -0.7s by the ten-second mark, snapping to suspiciously
 * round values. ffmpeg's `silencedetect` on the same track landed every boundary
 * within ~4ms. Captions half a second late look broken, and a cut half a second
 * early clips the first word off a sentence, so the timing has to come from the
 * measurement and only the words come from the model.
 */

/** A stretch of continuous speech, in seconds from the start of the audio. */
export type SpeechRun = { startSeconds: number; endSeconds: number };

export type SilenceOptions = {
  /**
   * Level below which audio counts as silence.
   *
   * -35dB is deliberately conservative for phone footage recorded in a room:
   * a lower threshold starts treating room tone and breath as speech, and a
   * higher one clips quiet word endings.
   */
  noiseFloorDb?: number;
  /**
   * How long a quiet patch must last to count as a pause worth cutting.
   *
   * Below about a quarter of a second, a "silence" is usually the gap between
   * two words or the stop consonant inside one, and cutting there produces the
   * chopped, breathless sound that makes an edit obvious.
   */
  minSilenceSeconds?: number;
};

const DEFAULTS: Required<SilenceOptions> = {
  noiseFloorDb: -35,
  minSilenceSeconds: 0.25,
};

/** `silence_start: 12.34` / `silence_end: 13.5 | silence_duration: 1.16` */
const SILENCE_START = /silence_start:\s*(-?[\d.]+)/;
const SILENCE_END = /silence_end:\s*(-?[\d.]+)/;

/**
 * Inverts ffmpeg's silence report into the speech between the silences.
 *
 * Exported for its own sake because this is the fiddly half: ffmpeg reports
 * *silences*, and the edge cases — audio that opens or closes mid-silence, a
 * track that is silent throughout — are exactly where an off-by-one produces a
 * video that starts a word late.
 */
export function speechRunsFromSilences(
  silences: Array<{ startSeconds: number; endSeconds: number | null }>,
  totalDurationSeconds: number
): SpeechRun[] {
  const runs: SpeechRun[] = [];
  let cursor = 0;

  for (const silence of silences) {
    // A silence starting at or before the cursor means the audio opened quiet;
    // there is no speech to emit before it, only a cursor to advance.
    if (silence.startSeconds > cursor) {
      runs.push({ startSeconds: cursor, endSeconds: Math.min(silence.startSeconds, totalDurationSeconds) });
    }
    // A silence with no end runs to the end of the file, so nothing follows it.
    if (silence.endSeconds === null) return runs.filter(isRealRun);
    cursor = Math.max(cursor, silence.endSeconds);
  }

  if (cursor < totalDurationSeconds) {
    runs.push({ startSeconds: cursor, endSeconds: totalDurationSeconds });
  }

  return runs.filter(isRealRun);
}

/**
 * Discards runs too short to be a word.
 *
 * A click, a lip smack or a single frame of noise crossing the threshold would
 * otherwise become a "speech run" the editor tries to keep, which is how an
 * edit ends up with 80ms fragments spliced between sentences.
 */
const MIN_RUN_SECONDS = 0.12;

function isRealRun(run: SpeechRun): boolean {
  return run.endSeconds - run.startSeconds >= MIN_RUN_SECONDS;
}

/**
 * Runs `silencedetect` over a media file and returns where the speech is.
 *
 * Reads ffmpeg's stderr rather than producing an output file — `-f null -`
 * decodes the audio and throws the samples away, which is all this needs.
 */
export async function detectSpeechRuns(
  mediaPath: string,
  options: SilenceOptions = {}
): Promise<{ runs: SpeechRun[]; durationSeconds: number }> {
  const { noiseFloorDb, minSilenceSeconds } = { ...DEFAULTS, ...options };
  const binary = ffmpegPath;
  if (!binary) throw new Error('ffmpeg binary not found');

  let stderr = '';
  try {
    const result = await execFileAsync(
      binary,
      [
        '-hide_banner',
        '-i', mediaPath,
        '-af', `silencedetect=noise=${noiseFloorDb}dB:d=${minSilenceSeconds}`,
        '-f', 'null',
        '-',
      ],
      { maxBuffer: 10 * 1024 * 1024, windowsHide: true }
    );
    stderr = result.stderr;
  } catch (error) {
    // ffmpeg writes the report to stderr and can still exit non-zero on a file
    // with quirks it recovered from; the report is usable either way.
    const withStderr = error as { stderr?: string };
    if (!withStderr.stderr) throw error;
    stderr = withStderr.stderr;

    // A non-zero exit is only survivable if ffmpeg still got far enough to
    // report the file's duration. Without that it never decoded any audio —
    // an unreadable or non-media file — and continuing would hand the caller
    // "no speech found", which is a lie that silently produces an empty edit.
    if (parseDuration(stderr) === 0) throw error;
  }

  const silences: Array<{ startSeconds: number; endSeconds: number | null }> = [];
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.match(SILENCE_START);
    if (start) {
      silences.push({ startSeconds: Number(start[1]), endSeconds: null });
      continue;
    }
    const end = line.match(SILENCE_END);
    if (end && silences.length > 0) {
      silences[silences.length - 1].endSeconds = Number(end[1]);
    }
  }

  const durationSeconds = parseDuration(stderr);
  return { runs: speechRunsFromSilences(silences, durationSeconds), durationSeconds };
}

/** `Duration: 00:01:02.34,` from ffmpeg's own header dump. */
function parseDuration(stderr: string): number {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Merges runs separated by a gap too short to be worth cutting.
 *
 * Removing every detected pause produces speech with no breathing room, which
 * reads as machine-gunned rather than tight. Gaps below `keepGapSeconds` are
 * absorbed back into the surrounding speech so the delivery keeps its rhythm;
 * only the long pauses — the "erm, let me think" ones — are cut.
 */
export function mergeShortGaps(runs: SpeechRun[], keepGapSeconds: number): SpeechRun[] {
  if (runs.length === 0) return [];
  const merged: SpeechRun[] = [{ ...runs[0] }];

  for (const run of runs.slice(1)) {
    const previous = merged[merged.length - 1];
    if (run.startSeconds - previous.endSeconds <= keepGapSeconds) {
      previous.endSeconds = run.endSeconds;
    } else {
      merged.push({ ...run });
    }
  }

  return merged;
}

/**
 * Pads each run outwards, without letting neighbours overlap.
 *
 * `silencedetect` marks where the level crosses the threshold, which is a few
 * milliseconds *inside* the first and last phoneme — cutting exactly there
 * shaves the attack off a "p" or the tail off an "s". A small pad restores it.
 * Runs are never allowed to cross, so padding can add material but can never
 * reorder or duplicate it.
 */
export function padRuns(
  runs: SpeechRun[],
  padSeconds: number,
  totalDurationSeconds: number
): SpeechRun[] {
  return runs.map((run, index) => {
    /*
     * Bounded by the midpoint of each gap, not by the neighbour itself.
     *
     * Clamping to the neighbour's own edge looks right and is not: both runs
     * expand into the same gap, so each stops at the *other's* original
     * boundary and they cross. Two overlapping cuts means the same audio is
     * spliced in twice — a stutter on the seam. The midpoint is the furthest
     * either can grow while staying disjoint, so they may meet but never
     * overlap.
     */
    const startBound =
      index > 0 ? (runs[index - 1].endSeconds + run.startSeconds) / 2 : 0;
    const endBound =
      index < runs.length - 1
        ? (run.endSeconds + runs[index + 1].startSeconds) / 2
        : totalDurationSeconds;

    return {
      startSeconds: Math.max(run.startSeconds - padSeconds, startBound, 0),
      endSeconds: Math.min(run.endSeconds + padSeconds, endBound, totalDurationSeconds),
    };
  });
}
