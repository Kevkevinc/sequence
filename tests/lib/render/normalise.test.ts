import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  runFfmpeg,
  probeAudioParameters,
  probeDimensions,
  probeDuration,
  probeHasAudio,
  probeRotation,
} from '@/lib/render/ffmpeg';
import { normaliseCut } from '@/lib/render/normalise';

/**
 * Reads one pixel back out of a rendered video.
 *
 * Crops 2x2 rather than 1x1 because the encoded frames are yuv420p: a 1px-wide
 * crop leaves the chroma planes zero-width and ffmpeg refuses it. Only the
 * first pixel of the block is returned.
 */
async function samplePixel(
  video: string,
  x: number,
  y: number,
  dir: string
): Promise<[number, number, number]> {
  const raw = path.join(dir, `px-${x}-${y}-${path.basename(video)}.raw`);
  const result = await runFfmpeg([
    '-i', video,
    '-vf', `crop=2:2:${x}:${y},format=rgb24`,
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    raw,
  ]);
  if (!result.success) throw new Error(`Could not sample pixel: ${result.error}`);
  const bytes = await readFile(raw);
  return [bytes[0], bytes[1], bytes[2]];
}

const isRed = ([r, g, b]: [number, number, number]) => r > 150 && g < 90 && b < 90;
const isBlue = ([r, g, b]: [number, number, number]) => b > 150 && r < 90 && g < 90;

describe('normaliseCut', () => {
  let dir: string;
  let source: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ugc-normalise-'));
    source = path.join(dir, 'source.mp4');
    // A 10s 640x480 test pattern with a tone: deliberately NOT 9:16, so the
    // test proves the reframing rather than passing through.
    const made = await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30:duration=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source,
    ]);
    expect(made.success).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('trims to the requested range and reframes to 1080x1920', async () => {
    const out = path.join(dir, 'cut.mp4');
    const result = await normaliseCut({
      sourcePath: source, startSeconds: 2, endSeconds: 5, outputPath: out,
    });

    expect(result.success).toBe(true);
    expect(existsSync(out)).toBe(true);

    expect(await probeDimensions(out)).toEqual({ width: 1080, height: 1920 });
    // Allow a frame of slack; ffmpeg cuts on frame boundaries.
    expect(await probeDuration(out)).toBeCloseTo(3, 1);
  }, 60_000);

  it('produces an audio track even when the source has none', async () => {
    const silent = path.join(dir, 'silent.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30:duration=5',
      '-c:v', 'libx264', silent,
    ]);
    expect(await probeHasAudio(silent)).toBe(false);

    const out = path.join(dir, 'from-silent.mp4');
    const result = await normaliseCut({
      sourcePath: silent, startSeconds: 0, endSeconds: 3, outputPath: out,
    });

    expect(result.success).toBe(true);
    // Without this, concatenating a silent cut with a noisy one desyncs or fails.
    expect(await probeHasAudio(out)).toBe(true);
    expect(await probeDuration(out)).toBeCloseTo(3, 1);
  }, 60_000);

  it('gives every cut the same audio parameters so they can be concatenated', async () => {
    const withAudio = path.join(dir, 'params-audio.mp4');
    const withoutAudio = path.join(dir, 'params-silent.mp4');
    const silentSource = path.join(dir, 'silent.mp4');

    expect((await normaliseCut({
      sourcePath: source, startSeconds: 1, endSeconds: 3, outputPath: withAudio,
    })).success).toBe(true);
    expect((await normaliseCut({
      sourcePath: silentSource, startSeconds: 1, endSeconds: 3, outputPath: withoutAudio,
    })).success).toBe(true);

    const a = await probeAudioParameters(withAudio);
    const b = await probeAudioParameters(withoutAudio);
    // Task 3 concatenates with the concat demuxer and `-c copy`, which only
    // works if every part shares codec, sample rate and channel count.
    expect(a).toEqual({ codec: 'aac', sampleRate: 44100, channels: 2 });
    expect(b).toEqual(a);
    // Audio must not drift against video, or each part shifts the next one.
    expect(await probeDuration(withAudio)).toBeCloseTo(await probeDuration(withoutAudio), 2);
  }, 60_000);

  it('renders rotated phone footage upright rather than sideways', async () => {
    // iPhone clips are stored landscape with a display-matrix rotation. Build
    // the same thing: 640x480 frames whose left third is red, tagged 90deg, so
    // the *displayed* frame is 480x640 portrait with red along the bottom.
    const flat = path.join(dir, 'rot-flat.mp4');
    const rotated = path.join(dir, 'rot-source.mp4');
    expect((await runFfmpeg([
      '-f', 'lavfi',
      '-i', 'color=c=blue:s=640x480:r=30:d=3,drawbox=x=0:y=0:w=213:h=480:color=red:t=fill',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', flat,
    ])).success).toBe(true);
    expect((await runFfmpeg([
      '-display_rotation', '90', '-i', flat, '-c', 'copy', rotated,
    ])).success).toBe(true);

    const out = path.join(dir, 'rot-out.mp4');
    const result = await normaliseCut({
      sourcePath: rotated, startSeconds: 0, endSeconds: 2, outputPath: out,
    });
    expect(result.success).toBe(true);

    expect(await probeDimensions(out)).toEqual({ width: 1080, height: 1920 });
    // Upright: blue across the top, the red band along the bottom. Ignoring the
    // rotation would instead crop the middle of the landscape frame, leaving
    // blue at both sample points.
    expect(isBlue(await samplePixel(out, 540, 192, dir))).toBe(true);
    expect(isRed(await samplePixel(out, 540, 1728, dir))).toBe(true);

    // The output is physically upright, so it must not also carry a rotation
    // tag — a player would rotate it a second time.
    expect(await probeRotation(out)).toBe(0);
  }, 90_000);

  it('rejects a cut with non-positive duration instead of running ffmpeg', async () => {
    const out = path.join(dir, 'never-written.mp4');
    const result = await normaliseCut({
      sourcePath: source, startSeconds: 4, endSeconds: 4, outputPath: out,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('duration');
    expect(existsSync(out)).toBe(false);
  });

  it('reports the source path when the source does not exist', async () => {
    const result = await normaliseCut({
      sourcePath: path.join(dir, 'missing.mp4'),
      startSeconds: 0,
      endSeconds: 1,
      outputPath: path.join(dir, 'missing-out.mp4'),
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('missing.mp4');
  }, 60_000);
});
