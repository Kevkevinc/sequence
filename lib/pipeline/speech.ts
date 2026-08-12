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
   * Pins the silence threshold in dB, overriding the adaptive one.
   *
   * Normally left unset: a fixed floor cannot serve both a quiet bedroom and a
   * noisy street, which is why the threshold follows the recording by default.
   */
  noiseFloorDb?: number;
  /**
   * How far under the recording's own average level the threshold sits.
   *
   * 5dB is deliberately close to the average. Creators want their pauses gone,
   * and a wider margin only catches the obvious ones: at 8dB a real pause
   * beginning at 16.7s was not picked up until 17.1s, because the decaying tail
   * of the previous word kept breaking the run, leaving half a second of dead
   * air in the export. Closer in, the pause is caught where it actually starts.
   * Much closer than this and the quiet moments *inside* words start counting
   * as silence, which clips word endings.
   */
  thresholdBelowMeanDb?: number;
  /**
   * How long a quiet patch must last to count as a pause worth cutting.
   *
   * A pause has to be *sustained*, not momentary. In rapid speech the gaps
   * between syllables register as one or two quiet windows, and at 0.10s those
   * qualified — producing cuts inside phrases. 0.15s is longer than any
   * inter-syllable gap measured on real footage and shorter than any real
   * pause, which is the distinction level alone cannot make: a breath and the
   * gap between two syllables sit at the same loudness and differ in length.
   */
  minSilenceSeconds?: number;
  /** Resolution of the loudness measurement. */
  windowSeconds?: number;
};

const DEFAULTS: Required<Omit<SilenceOptions, 'noiseFloorDb'>> & { noiseFloorDb?: number } = {
  thresholdBelowMeanDb: 5,
  minSilenceSeconds: 0.15,
  windowSeconds: 0.05,
  noiseFloorDb: undefined,
};

/** Everything is measured at one rate so window maths is exact. */
const ANALYSIS_SAMPLE_RATE = 16_000;

/** `lavfi.astats.Overall.RMS_level=-23.4` (or `-inf` for a dead-silent window). */
const RMS_LEVEL = /lavfi\.astats\.Overall\.RMS_level=(-inf|-?[\d.]+)/g;

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
 * Deliberately barely longer than one measurement window. A click or a lip
 * smack in the middle of a long pause should not split it into two unusable
 * halves — but this filter cuts the other way too, and that is far more
 * dangerous: dropping a short *speech* run fuses the quiet either side of it
 * into one long "pause" that never existed.
 *
 * At 0.12s that is exactly what happened. In rapid speech the syllables of
 * "if you don't have a fitted shirt" register as 0.10s runs separated by 0.05s
 * gaps; every syllable was thrown away and the whole phrase became a 0.75s
 * silence the editor then cut out — removing words the creator said. The
 * failure is silent, because what is left still sounds like speech.
 *
 * So the bar sits just above a single window. Everything that actually protects
 * against noise does it by looking at the *gaps*: a pause must be long enough
 * to detect, survive merging, and still be worth cutting after padding. Those
 * three can only ever keep material. This one can delete it.
 */
const MIN_RUN_SECONDS = 0.06;

function isRealRun(run: SpeechRun): boolean {
  return run.endSeconds - run.startSeconds >= MIN_RUN_SECONDS;
}

/** One RMS reading per window, in dB, plus the file's length. */
async function measureLoudness(
  mediaPath: string,
  windowSeconds: number
): Promise<{ windowsDb: number[]; durationSeconds: number; meanDb: number }> {
  const binary = ffmpegPath;
  if (!binary) throw new Error('ffmpeg binary not found');

  const samplesPerWindow = Math.max(1, Math.round(ANALYSIS_SAMPLE_RATE * windowSeconds));
  let stderr = '';

  try {
    const result = await execFileAsync(
      binary,
      [
        '-hide_banner',
        '-i', mediaPath,
        '-af',
        `aresample=${ANALYSIS_SAMPLE_RATE},asetnsamples=${samplesPerWindow},` +
          `astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-,` +
          `volumedetect`,
        '-f', 'null',
        '-',
      ],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    );
    stderr = `${result.stdout}
${result.stderr}`;
  } catch (error) {
    const withOutput = error as { stdout?: string; stderr?: string };
    if (!withOutput.stderr && !withOutput.stdout) throw error;
    stderr = `${withOutput.stdout ?? ''}
${withOutput.stderr ?? ''}`;
    if (parseDuration(stderr) === 0) throw error;
  }

  const windowsDb: number[] = [];
  for (const match of stderr.matchAll(RMS_LEVEL)) {
    // A completely silent window reports -inf; treated as the floor rather
    // than dropped, so window N always corresponds to second N*windowSeconds.
    windowsDb.push(match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]));
  }

  const mean = stderr.match(/mean_volume:\s*(-?[\d.]+)/);
  return {
    windowsDb,
    durationSeconds: parseDuration(stderr),
    meanDb: mean ? Number(mean[1]) : -30,
  };
}

/**
 * Finds where somebody is actually talking.
 *
 * Measures RMS per window rather than using ffmpeg's `silencedetect`, which was
 * the original implementation and gets breaths wrong. `silencedetect` compares
 * *peak* amplitude against the threshold, and a breath is quiet on average
 * while still carrying sharp transients — so its peaks stay above the line and
 * it never registers as a pause. On a real tester recording the level sat at
 * -43dB for seven tenths of a second and `silencedetect` reported nothing at
 * all. RMS is both what the ear responds to and what makes a breath visible.
 *
 * The threshold is derived from the recording rather than fixed. A fixed floor
 * cannot serve a quiet bedroom and a noisy street at once: too low and every
 * pause is missed, too high and quiet speech is cut off mid-word. Sitting it a
 * set distance under the recording's own average places it between that
 * speaker's speech and that room's noise.
 */
export async function detectSpeechRuns(
  mediaPath: string,
  options: SilenceOptions = {}
): Promise<{ runs: SpeechRun[]; durationSeconds: number }> {
  const { minSilenceSeconds, windowSeconds, thresholdBelowMeanDb, noiseFloorDb } = {
    ...DEFAULTS,
    ...options,
  };

  const { windowsDb, durationSeconds, meanDb } = await measureLoudness(mediaPath, windowSeconds);
  if (windowsDb.length === 0) {
    return { runs: [], durationSeconds };
  }

  // An explicit floor still wins, so a caller can pin it; otherwise it follows
  // the recording. Clamped so a pathological measurement cannot produce a
  // threshold that calls everything, or nothing, silence.
  const threshold =
    noiseFloorDb ?? Math.min(-20, Math.max(-55, meanDb - thresholdBelowMeanDb));

  const silences: Array<{ startSeconds: number; endSeconds: number | null }> = [];
  let runStart: number | null = null;

  windowsDb.forEach((db, index) => {
    const quiet = db < threshold;
    if (quiet && runStart === null) runStart = index;
    if (!quiet && runStart !== null) {
      const seconds = (index - runStart) * windowSeconds;
      if (seconds >= minSilenceSeconds) {
        silences.push({ startSeconds: runStart * windowSeconds, endSeconds: index * windowSeconds });
      }
      runStart = null;
    }
  });

  if (runStart !== null) {
    const seconds = (windowsDb.length - runStart) * windowSeconds;
    if (seconds >= minSilenceSeconds) {
      silences.push({ startSeconds: runStart * windowSeconds, endSeconds: null });
    }
  }

  return {
    runs: speechRunsFromSilences(silences, durationSeconds),
    durationSeconds,
  };
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
