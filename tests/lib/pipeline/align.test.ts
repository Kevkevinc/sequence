import { describe, it, expect } from 'vitest';
import {
  alignWordsToRuns,
  buildCaptionCues,
  speechOffsetToRealTime,
  totalSpeechSeconds,
} from '@/lib/pipeline/align';

const RUNS = [
  { startSeconds: 0, endSeconds: 2 },
  { startSeconds: 5, endSeconds: 7 },
];

describe('speechOffsetToRealTime', () => {
  it('maps a position in the speech to a position in the recording', () => {
    // Two seconds of speech, a three-second pause, two more seconds of speech.
    expect(speechOffsetToRealTime(0, RUNS)).toBe(0);
    expect(speechOffsetToRealTime(1, RUNS)).toBe(1);
    // Past the first run: the pause does not count as speech, so this lands in
    // the second run rather than in the silence.
    expect(speechOffsetToRealTime(2.5, RUNS)).toBe(5.5);
    expect(speechOffsetToRealTime(4, RUNS)).toBe(7);
  });

  it('clamps past the end instead of inventing a timestamp', () => {
    expect(speechOffsetToRealTime(99, RUNS)).toBe(7);
    expect(speechOffsetToRealTime(1, [])).toBe(0);
  });
});

describe('totalSpeechSeconds', () => {
  it('counts speech only, not the pauses between it', () => {
    expect(totalSpeechSeconds(RUNS)).toBe(4);
    expect(totalSpeechSeconds([])).toBe(0);
  });
});

describe('alignWordsToRuns', () => {
  it('places every word inside real speech, never in a gap', () => {
    const words = ['hello', 'everyone', 'this', 'is', 'a', 'test', 'of', 'captions'];
    const timed = alignWordsToRuns(words, RUNS);

    expect(timed).toHaveLength(words.length);
    for (const word of timed) {
      const insideARun = RUNS.some(
        (run) => word.startSeconds >= run.startSeconds - 1e-6 && word.startSeconds <= run.endSeconds + 1e-6
      );
      // A caption starting during a silence is a caption that appears over a
      // cut that is about to be removed.
      expect(insideARun).toBe(true);
    }
  });

  it('keeps the words in order and starts on the first frame of speech', () => {
    const timed = alignWordsToRuns(['one', 'two', 'three'], RUNS);
    expect(timed.map((w) => w.word)).toEqual(['one', 'two', 'three']);
    expect(timed[0].startSeconds).toBe(0);
    for (let i = 1; i < timed.length; i++) {
      expect(timed[i].startSeconds).toBeGreaterThanOrEqual(timed[i - 1].startSeconds);
    }
  });

  it('gives a longer word more time than a short one', () => {
    const timed = alignWordsToRuns(['a', 'extraordinarily'], RUNS);
    const short = timed[0].endSeconds - timed[0].startSeconds;
    const long = timed[1].endSeconds - timed[1].startSeconds;
    expect(long).toBeGreaterThan(short);
  });

  it('handles empty input on either side', () => {
    expect(alignWordsToRuns([], RUNS)).toEqual([]);
    expect(alignWordsToRuns(['hello'], [])).toEqual([]);
    expect(alignWordsToRuns(['', '  '], RUNS)).toEqual([]);
  });

  it('never emits a zero-length word', () => {
    // 40 words over four seconds of speech is faster than anyone talks, but it
    // must still produce captions that are on screen for a non-zero time.
    const many = Array.from({ length: 40 }, (_, i) => `w${i}`);
    for (const word of alignWordsToRuns(many, RUNS)) {
      expect(word.endSeconds).toBeGreaterThan(word.startSeconds);
    }
  });
});

describe('buildCaptionCues', () => {
  const words = alignWordsToRuns(
    ['hello', 'everyone', 'this', 'is', 'a', 'test', 'of', 'captions'],
    RUNS
  );

  it('groups words into short cues', () => {
    const cues = buildCaptionCues(words, RUNS, { maxWords: 3, maxSeconds: 10 });
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.text.split(' ').length).toBeLessThanOrEqual(3);
      expect(cue.endSeconds).toBeGreaterThan(cue.startSeconds);
    }
    // Nothing is lost or reordered in the grouping.
    expect(cues.map((c) => c.text).join(' ').split(' ')).toEqual(words.map((w) => w.word));
  });

  it('never lets one caption span a silence', () => {
    // A cue crossing a pause stays on screen over the cut that removes it.
    const cues = buildCaptionCues(words, RUNS, { maxWords: 99, maxSeconds: 99 });
    for (const cue of cues) {
      const run = RUNS.find(
        (r) => cue.startSeconds >= r.startSeconds - 1e-6 && cue.startSeconds <= r.endSeconds + 1e-6
      );
      expect(run).toBeDefined();
      expect(cue.endSeconds).toBeLessThanOrEqual(run!.endSeconds + 1e-6);
    }
  });

  it('splits a cue that would linger too long', () => {
    const cues = buildCaptionCues(words, RUNS, { maxWords: 99, maxSeconds: 0.6 });
    // A cue is closed before the word that would overrun, so it can exceed the
    // limit only by that final word's own length — never by more.
    const longestWord = Math.max(...words.map((w) => w.endSeconds - w.startSeconds));
    for (const cue of cues) {
      expect(cue.endSeconds - cue.startSeconds).toBeLessThanOrEqual(0.6 + longestWord);
    }
    expect(cues.length).toBeGreaterThan(2);
  });

  it('returns nothing for no words', () => {
    expect(buildCaptionCues([], RUNS)).toEqual([]);
  });
});
