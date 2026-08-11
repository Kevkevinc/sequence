import type { SpeechRun } from '@/lib/pipeline/speech';

/**
 * Puts real timings on transcribed words.
 *
 * The model returns the words in order and gets them right; what it cannot do
 * is say when they happen (see the note in `speech.ts` — 0.7s of drift by ten
 * seconds in). The speech runs, by contrast, are measured to within a few
 * milliseconds but contain no words. This joins the two.
 *
 * The model's own timestamps are deliberately not used, even as a hint.
 * Anchoring to a number known to drift would make the result drift with it,
 * and unpredictably; spreading the words across the measured speech is wrong
 * by a bounded, understandable amount instead. Every run boundary — the moment
 * a sentence starts and stops — stays exact, which is what a viewer actually
 * notices.
 */

export type TimedWord = {
  word: string;
  startSeconds: number;
  endSeconds: number;
};

/**
 * Relative time a word takes to say.
 *
 * Characters are a crude proxy for syllables but a reliable one at this scale,
 * and the alternative — a syllable counter — is a pile of English-specific
 * heuristics that fail on exactly the product names this app is full of. The
 * floor keeps one-letter words ("I", "a") from collapsing to nothing.
 */
function weightOf(word: string): number {
  return Math.max(2, word.replace(/[^\p{L}\p{N}]/gu, '').length);
}

/** Total seconds of real speech across every run. */
export function totalSpeechSeconds(runs: SpeechRun[]): number {
  return runs.reduce((total, run) => total + (run.endSeconds - run.startSeconds), 0);
}

/**
 * Converts a position along the concatenated speech into a real timestamp.
 *
 * "1.5 seconds into the speech" is not "1.5 seconds into the recording" once
 * the pauses are removed; this walks the runs to find where that instant
 * actually falls.
 */
export function speechOffsetToRealTime(offsetSeconds: number, runs: SpeechRun[]): number {
  let remaining = offsetSeconds;
  for (const run of runs) {
    const length = run.endSeconds - run.startSeconds;
    if (remaining <= length) return run.startSeconds + Math.max(0, remaining);
    remaining -= length;
  }
  // Past the end of the speech: clamp to the last run rather than inventing a
  // timestamp beyond the recording.
  const last = runs[runs.length - 1];
  return last ? last.endSeconds : 0;
}

/**
 * Spreads `words` across `runs`, giving each a real start and end.
 *
 * Words are never reordered and never straddle a gap: a word is placed within
 * whichever run its span falls in, so a caption cannot begin during a silence
 * that is about to be cut out.
 */
export function alignWordsToRuns(words: string[], runs: SpeechRun[]): TimedWord[] {
  const usable = words.filter((word) => word.trim().length > 0);
  if (usable.length === 0 || runs.length === 0) return [];

  const speechSeconds = totalSpeechSeconds(runs);
  const totalWeight = usable.reduce((sum, word) => sum + weightOf(word), 0);

  const timed: TimedWord[] = [];
  let offset = 0;

  for (const word of usable) {
    const share = (weightOf(word) / totalWeight) * speechSeconds;
    const startSeconds = speechOffsetToRealTime(offset, runs);
    const rawEnd = speechOffsetToRealTime(offset + share, runs);

    /*
     * A word's span can cross a gap: its share of the speech may run past the
     * end of the run it started in and resume in the next one, so the raw end
     * lands after a silence the edit is about to remove. Held inside its own
     * run, so a caption is on screen only while that word is being said.
     */
    const run = runs.find(
      (candidate) =>
        startSeconds >= candidate.startSeconds - 1e-6 &&
        startSeconds <= candidate.endSeconds + 1e-6
    );
    const ceiling = run ? run.endSeconds : rawEnd;

    timed.push({
      word,
      startSeconds,
      // The floor keeps a word from collapsing to zero length when the speech
      // is dense; it can still not exceed the run it belongs to.
      endSeconds: Math.min(Math.max(rawEnd, startSeconds + 0.05), Math.max(ceiling, startSeconds + 0.05)),
    });
    offset += share;
  }

  return timed;
}

/** A group of words shown together as one caption. */
export type CaptionCue = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type CueOptions = {
  /** Most words on screen at once. Short groups are the TikTok caption idiom. */
  maxWords?: number;
  /** Longest a single caption may stay up before it is split. */
  maxSeconds?: number;
};

const CUE_DEFAULTS: Required<CueOptions> = { maxWords: 4, maxSeconds: 1.8 };

/**
 * Groups timed words into the captions that actually go on screen.
 *
 * A cue is closed whenever the next word would make it too long, too wordy, or
 * would drag it across a silence. That last one matters most: a caption
 * spanning a pause is a caption that stays up over a cut, which looks like a
 * bug even though the timing is right.
 */
export function buildCaptionCues(
  words: TimedWord[],
  runs: SpeechRun[],
  options: CueOptions = {}
): CaptionCue[] {
  const { maxWords, maxSeconds } = { ...CUE_DEFAULTS, ...options };
  const cues: CaptionCue[] = [];
  let current: TimedWord[] = [];

  const runOf = (time: number) =>
    runs.findIndex((run) => time >= run.startSeconds - 1e-6 && time <= run.endSeconds + 1e-6);

  const flush = () => {
    if (current.length === 0) return;
    cues.push({
      text: current.map((w) => w.word).join(' '),
      startSeconds: current[0].startSeconds,
      endSeconds: current[current.length - 1].endSeconds,
    });
    current = [];
  };

  for (const word of words) {
    if (current.length > 0) {
      const wouldSpan = runOf(word.startSeconds) !== runOf(current[0].startSeconds);
      const tooLong = word.endSeconds - current[0].startSeconds > maxSeconds;
      if (wouldSpan || tooLong || current.length >= maxWords) flush();
    }
    current.push(word);
  }
  flush();

  return cues;
}
