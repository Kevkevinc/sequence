import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runFfmpeg, probeDimensions, probeDuration } from '@/lib/render/ffmpeg';
import { normaliseCut } from '@/lib/render/normalise';
import { concatCuts } from '@/lib/render/concat';
import { WIDTH, HEIGHT } from '@/lib/render/frame';

const FRAME_SECONDS = 1 / 30;

/**
 * Reads one pixel back out of a rendered video at a given time.
 *
 * Crops 2x2 rather than 1x1 because the encoded frames are yuv420p: a 1px-wide
 * crop leaves the chroma planes zero-width and ffmpeg refuses it.
 */
async function samplePixelAt(
  video: string,
  seconds: number,
  dir: string
): Promise<[number, number, number]> {
  const raw = path.join(dir, `px-${seconds}-${path.basename(video)}.raw`);
  const result = await runFfmpeg([
    '-ss', String(seconds),
    '-i', video,
    '-vf', 'crop=2:2:540:960,format=rgb24',
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    raw,
  ]);
  if (!result.success) throw new Error(`Could not sample pixel: ${result.error}`);
  const bytes = await readFile(raw);
  return [bytes[0], bytes[1], bytes[2]];
}

/** Which of red/green/blue dominates — the identity of a solid-colour cut. */
function dominant([r, g, b]: [number, number, number]): 'red' | 'green' | 'blue' | 'other' {
  if (r > 120 && g < 90 && b < 90) return 'red';
  if (g > 100 && r < 90 && b < 90) return 'green';
  if (b > 120 && r < 90 && g < 90) return 'blue';
  return 'other';
}

describe('concatCuts', () => {
  let dir: string;
  let parts: string[];
  let partDurations: number[];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ugc-concat-'));

    // Three solid-colour sources, so the order of the parts is readable from
    // the finished video rather than merely assumed.
    const colours = ['red', 'green', 'blue'];
    const sources: string[] = [];
    for (const colour of colours) {
      const source = path.join(dir, `${colour}.mp4`);
      const made = await runFfmpeg([
        '-f', 'lavfi', '-i', `color=c=${colour}:s=720x1280:r=30:d=8`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source,
      ]);
      expect(made.success).toBe(true);
      sources.push(source);
    }

    // Deliberately fractional, unequal ranges. Task 2's suite was blind to a
    // 57ms bug because every fixture landed on an integer second; a concat of
    // parts that are all exactly 1/30s-aligned by luck would be just as blind.
    const ranges = [
      { startSeconds: 0.5, endSeconds: 2.25 },
      { startSeconds: 1.234, endSeconds: 3.777 },
      { startSeconds: 2.18, endSeconds: 4.59 },
    ];

    parts = [];
    for (const [index, range] of ranges.entries()) {
      const part = path.join(dir, `part-${index}.mp4`);
      const result = await normaliseCut({ ...range, sourcePath: sources[index], outputPath: part });
      expect(result.success).toBe(true);
      parts.push(part);
    }
    partDurations = await Promise.all(parts.map((part) => probeDuration(part)));
  }, 180_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('joins the parts into one video as long as the sum of them', async () => {
    const out = path.join(dir, 'joined.mp4');
    const result = await concatCuts(parts, out);

    expect(result.success).toBe(true);
    expect(existsSync(out)).toBe(true);

    const expected = partDurations.reduce((total, value) => total + value, 0);
    // A stream copy should not lose or invent time: a frame of slack across the
    // whole join, not a frame per splice.
    expect(Math.abs((await probeDuration(out)) - expected)).toBeLessThan(FRAME_SECONDS);
    expect(await probeDimensions(out)).toEqual({ width: WIDTH, height: HEIGHT });
  }, 120_000);

  it('preserves the order of the parts', async () => {
    const out = path.join(dir, 'ordered.mp4');
    expect((await concatCuts(parts, out)).success).toBe(true);

    // Sample inside each part rather than at the splices, which are ambiguous.
    const [first, second, third] = partDurations;
    const mid = (offset: number, length: number) => offset + length / 2;
    expect(dominant(await samplePixelAt(out, mid(0, first), dir))).toBe('red');
    expect(dominant(await samplePixelAt(out, mid(first, second), dir))).toBe('green');
    expect(dominant(await samplePixelAt(out, mid(first + second, third), dir))).toBe('blue');
  }, 120_000);

  it('concatenates a single part', async () => {
    const out = path.join(dir, 'single.mp4');
    const result = await concatCuts([parts[0]], out);

    expect(result.success).toBe(true);
    expect(Math.abs((await probeDuration(out)) - partDurations[0])).toBeLessThan(FRAME_SECONDS);
  }, 60_000);

  it('leaves no list file behind', async () => {
    const before = await readdir(dir);
    const out = path.join(dir, 'tidy.mp4');
    expect((await concatCuts(parts, out)).success).toBe(true);

    const after = await readdir(dir);
    // The finished video is the only new file; a leaked list file would show up
    // here, and Task 4 hands this function a directory it later inspects.
    expect(after.filter((name) => !before.includes(name))).toEqual(['tidy.mp4']);
  }, 120_000);

  it('rejects an empty list of parts without writing an output', async () => {
    const out = path.join(dir, 'empty.mp4');
    const result = await concatCuts([], out);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/no cuts|empty/i);
    expect(existsSync(out)).toBe(false);
  });

  it('reports a missing part by name and leaves nothing behind', async () => {
    const missing = path.join(dir, 'not-here.mp4');
    const out = path.join(dir, 'from-missing.mp4');
    const result = await concatCuts([parts[0], missing], out);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('not-here.mp4');
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it('leaves no output behind when ffmpeg itself fails', async () => {
    // A file that exists but is not a media file: the demuxer opens the output,
    // then rejects the input, which is exactly the half-written-file case.
    const junk = path.join(dir, 'junk.mp4');
    await import('fs/promises').then((fs) => fs.writeFile(junk, 'not a video'));

    const out = path.join(dir, 'from-junk.mp4');
    const result = await concatCuts([junk], out);

    expect(result.success).toBe(false);
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it('handles a path containing a single quote', async () => {
    // The list-file format quotes each path, so an apostrophe in a creator's
    // folder name would end the quoted string early and corrupt the list.
    const quoted = path.join(dir, "kev's part.mp4");
    await import('fs/promises').then((fs) => fs.copyFile(parts[0], quoted));

    const out = path.join(dir, 'quoted.mp4');
    const result = await concatCuts([quoted], out);

    expect(result.success).toBe(true);
    expect(Math.abs((await probeDuration(out)) - partDurations[0])).toBeLessThan(FRAME_SECONDS);
  }, 60_000);
});
