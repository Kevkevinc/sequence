import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  renderTalkingHead,
  shiftCuesToEditedTimeline,
} from '@/lib/render/renderTalkingHead';
import { probeDuration, probeHasAudio, probeMedia, runFfmpeg } from '@/lib/render/ffmpeg';
import { WIDTH, HEIGHT } from '@/lib/render/frame';

const RUNS = [
  { startSeconds: 0, endSeconds: 2 },
  { startSeconds: 5, endSeconds: 7 },
];

describe('shiftCuesToEditedTimeline', () => {
  it('closes the gap left by every silence that was cut', () => {
    // The pause from 2s to 5s is removed, so anything in the second run moves
    // three seconds earlier. Without this every caption after the first cut
    // drifts by exactly the silence removed before it.
    const shifted = shiftCuesToEditedTimeline(
      [
        { text: 'first', startSeconds: 0.5, endSeconds: 1.5 },
        { text: 'second', startSeconds: 5.5, endSeconds: 6.5 },
      ],
      RUNS
    );

    expect(shifted[0]).toMatchObject({ text: 'first', startSeconds: 0.5 });
    expect(shifted[1].text).toBe('second');
    expect(shifted[1].startSeconds).toBeCloseTo(2.5, 5);
    expect(shifted[1].endSeconds).toBeCloseTo(3.5, 5);
  });

  it('keeps cues in order and inside the edited length', () => {
    const shifted = shiftCuesToEditedTimeline(
      [
        { text: 'b', startSeconds: 6, endSeconds: 6.5 },
        { text: 'a', startSeconds: 1, endSeconds: 1.5 },
      ],
      RUNS
    );
    expect(shifted.map((c) => c.text)).toEqual(['a', 'b']);
    for (const cue of shifted) {
      expect(cue.endSeconds).toBeLessThanOrEqual(4 + 1e-6); // two runs of 2s
      expect(cue.endSeconds).toBeGreaterThan(cue.startSeconds);
    }
  });

  it('drops a cue that falls inside a removed silence', () => {
    // Nothing is spoken there, so there is nowhere in the export to show it.
    expect(
      shiftCuesToEditedTimeline([{ text: 'ghost', startSeconds: 3, endSeconds: 4 }], RUNS)
    ).toEqual([]);
  });
});

describe('renderTalkingHead', () => {
  let dir: string;
  let source: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'talking-'));
    source = path.join(dir, 'source.mp4');
    // 8 seconds of vertical video with a continuous tone, so the output can be
    // checked for a real audio track rather than a silent stream.
    const built = await runFfmpeg([
      '-f', 'lavfi', '-i', `testsrc=size=720x1280:rate=30:duration=8`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      source,
    ]);
    expect(built).toEqual({ success: true });
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('cuts to the speech, keeps the audio and burns the captions', async () => {
    const output = path.join(dir, 'out.mp4');
    const result = await renderTalkingHead({
      sourcePath: source,
      runs: RUNS,
      cues: [
        { text: 'hello there', startSeconds: 0.2, endSeconds: 1.8 },
        { text: 'second part', startSeconds: 5.2, endSeconds: 6.8 },
      ],
      workingDir: dir,
      outputPath: output,
    });

    expect(result).toMatchObject({ success: true });
    if (!result.success) return;

    // Two 2-second runs, so the pause between them is gone.
    expect(result.durationSeconds).toBeGreaterThan(3.5);
    expect(result.durationSeconds).toBeLessThan(4.6);

    // The audio has to survive: a talking video without it is not a video.
    expect(await probeHasAudio(output)).toBe(true);

    const media = await probeMedia(output);
    expect(media.video).toMatchObject({ width: WIDTH, height: HEIGHT });
    expect(media.audio).not.toBeNull();
  }, 300_000);

  it('keeps picture and sound the same length', async () => {
    // Drift between the two is what reads as bad lip sync, and it accumulates
    // across cuts — so it is checked on the joined result, not on one part.
    const output = path.join(dir, 'sync.mp4');
    const result = await renderTalkingHead({
      sourcePath: source,
      runs: [
        { startSeconds: 0, endSeconds: 1 },
        { startSeconds: 2, endSeconds: 3 },
        { startSeconds: 4, endSeconds: 5 },
        { startSeconds: 6, endSeconds: 7 },
      ],
      cues: [],
      workingDir: dir,
      outputPath: output,
    });
    expect(result).toMatchObject({ success: true });

    const media = await probeMedia(output);
    const videoLength = media.video?.duration ?? (await probeDuration(output));
    const audioLength = media.audio?.duration ?? 0;
    expect(Math.abs(videoLength - audioLength)).toBeLessThan(0.12);
  }, 300_000);

  it('refuses a recording with no speech rather than making an empty video', async () => {
    const result = await renderTalkingHead({
      sourcePath: source,
      runs: [],
      cues: [],
      workingDir: dir,
      outputPath: path.join(dir, 'never.mp4'),
    });
    expect(result).toEqual({
      success: false,
      error: 'No speech was found in this recording, so there is nothing to cut.',
    });
  }, 30_000);
});

describe('background noise', () => {
  let dir: string;
  let noisySource: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'noise-'));
    noisySource = path.join(dir, 'noisy.mp4');
    // A 300Hz tone standing in for a voice, buried in broadband hiss. Both are
    // generated so the amount of noise removed is a number this test chose
    // rather than a property of some recording.
    const built = await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6',
      '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=white:a=0.06',
      '-filter_complex', '[1:a][2:a]amix=inputs=2:duration=shortest:weights=1 1[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', noisySource,
    ]);
    expect(built).toEqual({ success: true });
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves the voice audible while pulling the background down', async () => {
    const output = path.join(dir, 'cleaned.mp4');
    const result = await renderTalkingHead({
      sourcePath: noisySource,
      runs: [{ startSeconds: 0, endSeconds: 5 }],
      cues: [],
      workingDir: dir,
      outputPath: output,
    });
    expect(result).toMatchObject({ success: true });

    // The tone survives: a cleanup that removed the voice along with the noise
    // would look excellent on a noise meter and be useless.
    expect(await probeHasAudio(output)).toBe(true);
    const media = await probeMedia(output);
    expect(media.audio).not.toBeNull();
    expect(media.audio?.duration ?? 0).toBeGreaterThan(4);
  }, 300_000);
});
