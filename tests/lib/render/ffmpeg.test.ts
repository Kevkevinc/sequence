import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  runFfmpeg,
  probeAudioParameters,
  probeDimensions,
  probeDuration,
  probeHasAudio,
  probeMedia,
  probeRotation,
} from '@/lib/render/ffmpeg';

describe('render/ffmpeg', () => {
  let dir: string;
  let video: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ugc-ffmpeg-'));
    // 2s of 320x240 pattern with a tone, so every probe has something to read.
    video = path.join(dir, 'probe-me.mp4');
    const made = await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-shortest', video,
    ]);
    expect(made.success).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('runFfmpeg', () => {
    it('writes the requested output and reports success', async () => {
      const out = path.join(dir, 'copied.mp4');
      const result = await runFfmpeg(['-i', video, '-c', 'copy', out]);

      expect(result).toEqual({ success: true });
      expect(existsSync(out)).toBe(true);
    }, 60_000);

    it('returns ffmpeg stderr rather than throwing when the input is missing', async () => {
      const result = await runFfmpeg([
        '-i', path.join(dir, 'no-such-file.mp4'), path.join(dir, 'nope.mp4'),
      ]);

      expect(result.success).toBe(false);
      if (result.success) return;
      // The exit code alone says nothing; ffmpeg puts the real diagnosis on
      // stderr, and that is what a stuck job's error column has to show.
      expect(result.error).toContain('no-such-file.mp4');
      expect(result.error).toMatch(/No such file|could not be opened/i);
    }, 60_000);

    it('returns an error for an unusable argument instead of throwing', async () => {
      const result = await runFfmpeg(['-definitely-not-an-option']);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.length).toBeGreaterThan(0);
    }, 60_000);

    it('says a render was timed out rather than echoing the command line', async () => {
      // A killed process writes nothing to stderr, so the fallback is Node's
      // "Command failed: <the whole command>" — useless in exactly the case
      // where somebody needs to know a long render was cut off, not rejected.
      const out = path.join(dir, 'never-finishes.mp4');
      const result = await runFfmpeg(
        [
          '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=600',
          '-c:v', 'libx264', '-preset', 'veryslow', out,
        ],
        { timeoutMs: 50 }
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('ffmpeg timed out after');
    }, 60_000);

    it('handles paths containing spaces and a drive letter', async () => {
      const spaced = path.join(dir, 'a file with spaces.mp4');
      const result = await runFfmpeg(['-i', video, '-c', 'copy', spaced]);

      expect(result.success).toBe(true);
      expect(existsSync(spaced)).toBe(true);
    }, 60_000);
  });

  describe('probes', () => {
    it('reads duration, dimensions, rotation and audio parameters', async () => {
      expect(await probeDuration(video)).toBeCloseTo(2, 1);
      expect(await probeDimensions(video)).toEqual({ width: 320, height: 240 });
      expect(await probeRotation(video)).toBe(0);
      expect(await probeHasAudio(video)).toBe(true);
      expect(await probeAudioParameters(video)).toEqual({
        codec: 'aac',
        sampleRate: 44100,
        channels: 2,
      });
    }, 60_000);

    it('returns every fact about a file from a single probe', async () => {
      // One spawn per file rather than one per question, and per-stream
      // durations that a container-level duration cannot express.
      const info = await probeMedia(video);

      expect(info.containerDuration).toBeCloseTo(2, 1);
      expect(info.video).toMatchObject({ width: 320, height: 240, rotation: 0 });
      expect(info.video?.duration).toBeCloseTo(2, 1);
      expect(info.audio).toMatchObject({ codec: 'aac', sampleRate: 44100, channels: 2 });
      expect(info.audio?.duration).toBeCloseTo(2, 1);
    }, 60_000);

    it('reports the container duration as the longer stream, and both separately', async () => {
      const lopsided = path.join(dir, 'lopsided.mp4');
      const made = await runFfmpeg([
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        '-c:v', 'libx264', '-c:a', 'aac', lopsided,
      ]);
      expect(made.success).toBe(true);

      const info = await probeMedia(lopsided);
      expect(info.video?.duration).toBeCloseTo(2, 1);
      expect(info.audio?.duration).toBeCloseTo(4, 1);
      // probeDuration cannot see the mismatch at all — hence probeMedia.
      expect(await probeDuration(lopsided)).toBeCloseTo(4, 1);
    }, 60_000);

    it('reports dimensions as displayed for footage with a rotation tag', async () => {
      const rotated = path.join(dir, 'rotated.mp4');
      const made = await runFfmpeg(['-display_rotation', '90', '-i', video, '-c', 'copy', rotated]);
      expect(made.success).toBe(true);

      expect(await probeRotation(rotated)).toBe(90);
      // Stored 320x240, shown 240x320 — a caller reasoning about aspect ratio
      // needs the shown size, not the stored one.
      expect(await probeDimensions(rotated)).toEqual({ width: 240, height: 320 });
    }, 60_000);

    it('reports no audio for a video without an audio stream', async () => {
      const silent = path.join(dir, 'silent.mp4');
      const made = await runFfmpeg([
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=1', '-c:v', 'libx264', silent,
      ]);
      expect(made.success).toBe(true);

      expect(await probeHasAudio(silent)).toBe(false);
      expect(await probeAudioParameters(silent)).toBeNull();
    }, 60_000);

    it('rejects rather than resolving nonsense when the file is not a video', async () => {
      await expect(probeDuration(path.join(dir, 'absent.mp4'))).rejects.toThrow();
    }, 60_000);
  });
});
