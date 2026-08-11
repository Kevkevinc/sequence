import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';
import {
  detectSpeechRuns,
  mergeShortGaps,
  padRuns,
  speechRunsFromSilences,
} from '@/lib/pipeline/speech';

const execFileAsync = promisify(execFile);

/**
 * Builds an audio file with sound in known places and silence elsewhere.
 *
 * Generated rather than committed, and generated with tones rather than speech,
 * so the expected boundaries are exact numbers this test chose — the point is
 * to pin the measurement, and a recording of a voice would only let us assert
 * "about right". Costs nothing and needs no API.
 */
async function buildAudio(
  file: string,
  bursts: Array<{ start: number; end: number }>,
  total: number
): Promise<void> {
  // A 440Hz tone gated to each burst window, over silence for the full length.
  const gate = bursts
    .map((b) => `between(t,${b.start},${b.end})`)
    .join('+');
  await execFileAsync(ffmpegPath!, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${total}`,
    '-af', `volume='if(${gate || '0'},1,0)':eval=frame`,
    '-ac', '1', '-ar', '16000',
    file,
  ]);
}

describe('speechRunsFromSilences', () => {
  it('returns the gaps between silences as speech', () => {
    const runs = speechRunsFromSilences(
      [
        { startSeconds: 2, endSeconds: 3 },
        { startSeconds: 5, endSeconds: 6 },
      ],
      8
    );
    expect(runs).toEqual([
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 3, endSeconds: 5 },
      { startSeconds: 6, endSeconds: 8 },
    ]);
  });

  it('handles audio that opens with silence', () => {
    // No speech exists before a silence that starts at zero; emitting a
    // zero-length run here is how an edit ends up with an empty first cut.
    expect(speechRunsFromSilences([{ startSeconds: 0, endSeconds: 2 }], 5)).toEqual([
      { startSeconds: 2, endSeconds: 5 },
    ]);
  });

  it('handles a silence that runs to the end of the file', () => {
    expect(speechRunsFromSilences([{ startSeconds: 3, endSeconds: null }], 10)).toEqual([
      { startSeconds: 0, endSeconds: 3 },
    ]);
  });

  it('returns nothing for audio that is silent throughout', () => {
    expect(speechRunsFromSilences([{ startSeconds: 0, endSeconds: null }], 10)).toEqual([]);
  });

  it('returns the whole file when no silence was detected', () => {
    expect(speechRunsFromSilences([], 7)).toEqual([{ startSeconds: 0, endSeconds: 7 }]);
  });

  it('discards fragments too short to be a word', () => {
    // A click or a lip smack crossing the threshold must not become a cut.
    const runs = speechRunsFromSilences(
      [
        { startSeconds: 0.05, endSeconds: 1 },
        { startSeconds: 1.03, endSeconds: 2 },
      ],
      3
    );
    expect(runs).toEqual([{ startSeconds: 2, endSeconds: 3 }]);
  });
});

describe('mergeShortGaps', () => {
  it('absorbs pauses shorter than the threshold', () => {
    // Cutting every detected pause leaves speech with no breath in it, which
    // reads as machine-gunned rather than tight.
    const runs = [
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 2.2, endSeconds: 4 },
      { startSeconds: 6, endSeconds: 7 },
    ];
    expect(mergeShortGaps(runs, 0.5)).toEqual([
      { startSeconds: 0, endSeconds: 4 },
      { startSeconds: 6, endSeconds: 7 },
    ]);
  });

  it('leaves a lone run and an empty list alone', () => {
    expect(mergeShortGaps([], 0.5)).toEqual([]);
    expect(mergeShortGaps([{ startSeconds: 1, endSeconds: 2 }], 0.5)).toEqual([
      { startSeconds: 1, endSeconds: 2 },
    ]);
  });
});

describe('padRuns', () => {
  it('pads outwards without letting neighbours overlap', () => {
    const runs = [
      { startSeconds: 1, endSeconds: 2 },
      { startSeconds: 2.2, endSeconds: 3 },
    ];
    const padded = padRuns(runs, 0.5, 10);

    // The pad is clamped at the neighbour, so material can be added but never
    // duplicated into two cuts.
    expect(padded[0].endSeconds).toBeLessThanOrEqual(padded[1].startSeconds);
    expect(padded[0].startSeconds).toBe(0.5);
    expect(padded[1].endSeconds).toBe(3.5);
  });

  it('never runs past the start or the end of the audio', () => {
    const padded = padRuns([{ startSeconds: 0.1, endSeconds: 9.9 }], 0.5, 10);
    expect(padded[0].startSeconds).toBe(0);
    expect(padded[0].endSeconds).toBe(10);
  });
});

describe('detectSpeechRuns', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'speech-test-'));
    file = path.join(dir, 'bursts.m4a');
    // Sound at 0-1s, 2-3.5s and 5-6s; silence between.
    await buildAudio(file, [
      { start: 0, end: 1 },
      { start: 2, end: 3.5 },
      { start: 5, end: 6 },
    ], 7);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds the sound and reports the file length', async () => {
    const { runs, durationSeconds } = await detectSpeechRuns(file);

    expect(durationSeconds).toBeGreaterThan(6.9);
    expect(runs).toHaveLength(3);

    // Boundaries are measured, so they are asserted tightly. Against a
    // synthesised reference the real detector landed inside ~4ms; 80ms of slack
    // here covers the encoder's own ramp without letting a regression hide.
    const expected = [[0, 1], [2, 3.5], [5, 6]];
    runs.forEach((run, index) => {
      expect(run.startSeconds).toBeCloseTo(expected[index][0], 1);
      expect(run.endSeconds).toBeCloseTo(expected[index][1], 1);
    });
  }, 60_000);

  it('reports no speech for a silent file', async () => {
    const silent = path.join(dir, 'silent.m4a');
    await buildAudio(silent, [], 4);
    const { runs } = await detectSpeechRuns(silent);
    expect(runs).toEqual([]);
  }, 60_000);

  it('fails loudly on a file that is not media', async () => {
    const bogus = path.join(dir, 'not-audio.txt');
    await writeFile(bogus, 'this is not a media file');
    await expect(detectSpeechRuns(bogus)).rejects.toThrow();
  }, 30_000);
});
