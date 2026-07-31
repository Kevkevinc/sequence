import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  runFfmpeg,
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

  it('strips audio even when the source has some', async () => {
    // v1 does not use source audio at all — AI-driven audio editing is a
    // future feature, not something re-sequenced cuts can honestly carry yet.
    expect(await probeHasAudio(source)).toBe(true);

    const out = path.join(dir, 'from-audio-source.mp4');
    const result = await normaliseCut({
      sourcePath: source, startSeconds: 0, endSeconds: 3, outputPath: out,
    });

    expect(result.success).toBe(true);
    expect(await probeHasAudio(out)).toBe(false);
    expect(await probeDuration(out)).toBeCloseTo(3, 1);
  }, 60_000);

  it('produces video-only output from a source that already has no audio', async () => {
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
    expect(await probeHasAudio(out)).toBe(false);
    expect(await probeDuration(out)).toBeCloseTo(3, 1);
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

  it('lands cuts on exact frame boundaries even when the requested times are not frame-aligned', async () => {
    // Every other test here uses whole seconds, which land on 1/30s boundaries
    // and hide the problem entirely. Real plans do not: lib/pipeline/director.ts
    // takes `z.number().min(0)` straight from the model, and its prompt invites
    // in/out points like 16s-18.5s. Unsnapped, the picture rounds up to the next
    // frame, so the concat demuxer's next part starts from a length that does
    // not match what was asked for.
    const cuts = [
      { startSeconds: 0.5, endSeconds: 2.25 },
      { startSeconds: 1.234, endSeconds: 3.777 },
      { startSeconds: 2.18, endSeconds: 5.59 },
    ];

    for (const cut of cuts) {
      const out = path.join(dir, `fractional-${cut.startSeconds}.mp4`);
      const result = await normaliseCut({ ...cut, sourcePath: source, outputPath: out });
      expect(result.success).toBe(true);
      expect(await probeDuration(out)).toBeCloseTo(cut.endSeconds - cut.startSeconds, 1);
    }
  }, 120_000);

  it('leaves no output file behind when ffmpeg itself fails', async () => {
    // A source whose headers are intact but whose payload is not: it probes
    // cleanly, then every frame fails to decode. ffmpeg opens the output before
    // initialising the graph, so without cleanup this leaves a 0-byte file —
    // and Task 3 iterates a directory of parts.
    const intact = path.join(dir, 'headers-ok.mp4');
    expect((await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', intact,
    ])).success).toBe(true);

    const corrupt = path.join(dir, 'corrupt.mp4');
    const bytes = await readFile(intact);
    // Keep ftyp+moov (written first thanks to faststart), destroy the payload.
    await writeFile(corrupt, Buffer.concat([bytes.subarray(0, 8192), Buffer.alloc(bytes.length - 8192)]));
    expect(await probeDuration(corrupt)).toBeCloseTo(4, 1);

    const out = path.join(dir, 'from-corrupt.mp4');
    const result = await normaliseCut({
      sourcePath: corrupt, startSeconds: 0, endSeconds: 3, outputPath: out,
    });

    expect(result.success).toBe(false);
    expect(existsSync(out)).toBe(false);
    if (!result.success) {
      // ffmpeg's diagnosis is the last thing it prints, after any amount of
      // decoder noise. This stderr runs to tens of kilobytes, so the stored
      // string must be its *end* — the leading ellipsis is the marker that the
      // front was dropped — and must carry the reason rather than Node's
      // "Command failed: <the whole command line>".
      expect(result.error.startsWith('...')).toBe(true);
      expect(result.error).toContain('Invalid data found');
      expect(result.error).not.toContain('Command failed');
    }
  }, 90_000);

  it('rejects a source with no video stream before running ffmpeg', async () => {
    const audioOnly = path.join(dir, 'audio-only.m4a');
    expect((await runFfmpeg([
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', audioOnly,
    ])).success).toBe(true);

    const out = path.join(dir, 'from-audio-only.mp4');
    const result = await normaliseCut({
      sourcePath: audioOnly, startSeconds: 0, endSeconds: 2, outputPath: out,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('no video stream');
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it('clamps a cut that runs past the end of the source', async () => {
    // The source is 10s. A plan asking for 8s-20s must yield a 2s cut, not a
    // 12s one padded out with nothing.
    const out = path.join(dir, 'overrun.mp4');
    const result = await normaliseCut({
      sourcePath: source, startSeconds: 8, endSeconds: 20, outputPath: out,
    });

    expect(result.success).toBe(true);
    expect(await probeDuration(out)).toBeCloseTo(2, 1);
  }, 60_000);

  it('rejects a cut starting past the end of the source', async () => {
    const out = path.join(dir, 'past-end.mp4');
    const result = await normaliseCut({
      sourcePath: source, startSeconds: 30, endSeconds: 33, outputPath: out,
    });

    expect(result.success).toBe(false);
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it('rejects a cut that clamps down to less than a frame', async () => {
    // Starting 10ms before the last frame leaves nothing to render; a part with
    // an empty video stream cannot be stream-copied into the concatenation.
    const out = path.join(dir, 'sub-frame.mp4');
    const result = await normaliseCut({
      sourcePath: source,
      startSeconds: (await probeDuration(source)) - 0.01,
      endSeconds: 999,
      outputPath: out,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('frame');
    expect(existsSync(out)).toBe(false);
  }, 60_000);

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
