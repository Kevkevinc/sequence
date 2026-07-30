import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { probeDimensions, probeDuration, probeHasAudio, runFfmpeg } from '@/lib/render/ffmpeg';
import {
  overlayText,
  renderHookLayer,
  renderSizingLayer,
  SIZING_PLACEMENTS,
  type SizingPlacement,
} from '@/lib/render/text';

const WIDTH = 1080;
const HEIGHT = 1920;

type Ink = {
  width: number;
  height: number;
  /** Pixels that are actually drawn on (alpha above a noise floor). */
  count: number;
  box: { left: number; top: number; right: number; bottom: number } | null;
};

/** Where the ink is, and how much of it there is, in a rendered PNG. */
async function inkOf(png: Buffer | string): Promise<Ink> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);

  let count = 0;
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      // Alpha for a transparent overlay; luminance for an opaque video frame,
      // where "drawn on" means white text over black footage.
      const index = (y * image.width + x) * 4;
      const drawn = data[index + 3] > 32 && data[index] + data[index + 1] + data[index + 2] > 90;
      if (!drawn) continue;
      count += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  return {
    width: image.width,
    height: image.height,
    count,
    box: right < 0 ? null : { left, top, right, bottom },
  };
}

/** The color at one pixel of a rendered PNG. */
async function pixelAt(png: Buffer | string, x: number, y: number): Promise<{ r: number; g: number; b: number; a: number }> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(x, y, 1, 1);
  return { r: data[0], g: data[1], b: data[2], a: data[3] };
}

/** Pulls a single frame out of a video at `seconds` and measures its ink. */
async function frameInk(video: string, seconds: number, dir: string): Promise<Ink> {
  const frame = path.join(dir, `frame-${seconds}-${path.basename(video)}.png`);
  const result = await runFfmpeg(['-ss', String(seconds), '-i', video, '-frames:v', '1', frame]);
  if (!result.success) throw new Error(`Could not extract a frame: ${result.error}`);
  return inkOf(frame);
}

/** The exact string the bundled ffmpeg's drawtext truncated to "POV". */
const AWKWARD_HOOK = 'POV: it\'s the "best" one, isn\'t it?';

describe('renderHookLayer', () => {
  it('renders a transparent 1080x1920 layer', () => {
    const { png } = renderHookLayer('anything');
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    return expect(inkOf(png)).resolves.toMatchObject({ width: WIDTH, height: HEIGHT });
  });

  it('draws the whole hook, colon and punctuation included', async () => {
    const full = await inkOf(renderHookLayer(AWKWARD_HOOK).png);
    const blank = await inkOf(renderHookLayer('').png);
    // drawtext silently truncated this at the colon, rendering "POV" — a video
    // that looks fine and says the wrong thing.
    const truncatedAtColon = await inkOf(renderHookLayer('POV').png);

    expect(blank.count).toBe(0);
    expect(full.count).toBeGreaterThan(1000);
    expect(full.count).toBeGreaterThan(truncatedAtColon.count * 4);
  });

  it('draws apostrophes and quotes rather than dropping them', async () => {
    // drawtext dropped apostrophes even when escaped. Stripping the punctuation
    // must therefore *lose* ink; if the two match, the punctuation never drew.
    const withPunctuation = await inkOf(renderHookLayer(AWKWARD_HOOK).png);
    const stripped = await inkOf(renderHookLayer(AWKWARD_HOOK.replace(/['"?]/g, '')).png);

    expect(withPunctuation.count).toBeGreaterThan(stripped.count);
  });

  it('wraps a long hook onto more lines than a short one', async () => {
    const short = renderHookLayer('POV');
    const long = renderHookLayer(
      'POV: you just found the streetwear zip-up hoodie everyone is talking about'
    );

    // drawtext offers no word wrap at all: the long hook would be one line
    // running off both edges of the frame.
    expect(long.blockHeight).toBeGreaterThan(short.blockHeight * 2);

    const ink = await inkOf(long.png);
    expect(ink.box).not.toBeNull();
    if (ink.box) {
      // Wrapped means it fits the frame with room for the outline, and it sits
      // in the upper part of the frame where the hook belongs.
      expect(ink.box.left).toBeGreaterThan(0);
      expect(ink.box.right).toBeLessThan(WIDTH - 1);
      expect(ink.box.bottom).toBeLessThan(HEIGHT / 2);
    }
  });

  it('keeps a hook of unbroken characters inside the frame', async () => {
    // No spaces to wrap on: a naive wrapper emits one line wider than the frame.
    const ink = await inkOf(renderHookLayer('a'.repeat(120)).png);
    expect(ink.box).not.toBeNull();
    if (ink.box) {
      expect(ink.box.left).toBeGreaterThanOrEqual(0);
      expect(ink.box.right).toBeLessThan(WIDTH - 1);
    }
  });

  it('produces nothing at all for whitespace-only text', async () => {
    expect((await inkOf(renderHookLayer('   \n  ').png)).count).toBe(0);
  });

  it('fails loudly rather than falling back when the font file is missing', () => {
    // The committed font must be loaded by path. If this silently fell through
    // to fontconfig, a missing file would still render — in whatever the
    // machine happens to have, which on Windows was a serif — and nothing would
    // ever report that the video looks wrong.
    const original = process.env.RENDER_FONT_PATH;
    process.env.RENDER_FONT_PATH = path.join(tmpdir(), 'definitely-not-a-font.ttf');
    try {
      expect(() => renderHookLayer('Fit check')).toThrow(/font/i);
    } finally {
      if (original === undefined) delete process.env.RENDER_FONT_PATH;
      else process.env.RENDER_FONT_PATH = original;
    }
    // And the real font still works afterwards.
    expect(renderHookLayer('Fit check').blockHeight).toBeGreaterThan(0);
  });
});

describe('renderSizingLayer', () => {
  const SIZING_TEXT = '5\'6", 140 lb, size L';

  it('draws the measurement text, quotes and all', async () => {
    const drawn = await inkOf(renderSizingLayer(SIZING_TEXT, 'bottom-left').png);
    expect(drawn.count).toBeGreaterThan(500);
  });

  it.each(SIZING_PLACEMENTS)('puts the block in the %s corner', async (placement) => {
    const ink = await inkOf(renderSizingLayer(SIZING_TEXT, placement as SizingPlacement).png);
    expect(ink.box).not.toBeNull();
    if (!ink.box) return;

    const [vertical, horizontal] = placement.split('-');
    const centreX = (ink.box.left + ink.box.right) / 2;

    if (vertical === 'top') expect(ink.box.bottom).toBeLessThan(HEIGHT / 2);
    else expect(ink.box.top).toBeGreaterThan(HEIGHT / 2);

    if (horizontal === 'left') expect(centreX).toBeLessThan(WIDTH / 2);
    else if (horizontal === 'right') expect(centreX).toBeGreaterThan(WIDTH / 2);
    else expect(Math.abs(centreX - WIDTH / 2)).toBeLessThan(WIDTH / 10);

    // Whatever the corner, it stays inside the frame.
    expect(ink.box.left).toBeGreaterThanOrEqual(0);
    expect(ink.box.right).toBeLessThan(WIDTH);
    expect(ink.box.top).toBeGreaterThanOrEqual(0);
    expect(ink.box.bottom).toBeLessThan(HEIGHT);
  });

  it('is smaller than the hook', async () => {
    const hook = renderHookLayer('Fit check');
    const sizing = renderSizingLayer('Fit check', 'bottom-left');
    expect(sizing.blockHeight).toBeLessThan(hook.blockHeight);
  });
});

describe('textColor', () => {
  it('draws in the requested color instead of the default white', async () => {
    const white = await inkOf(renderHookLayer('Fit check').png);
    const coloredLayer = renderHookLayer('Fit check', { textColor: '#00ff00' });
    const colored = await inkOf(coloredLayer.png);

    expect(colored.count).toBeGreaterThan(0);
    // Roughly the same layout/position — not pixel-exact, since anti-aliasing
    // shifts the detected edge by a pixel or two depending on fill color.
    expect(Math.abs(colored.box!.left - white.box!.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(colored.box!.top - white.box!.top)).toBeLessThanOrEqual(2);

    // The real color signal: sample a pixel well inside the drawn region (not
    // an anti-aliased edge, where the fill color is unambiguous) and confirm
    // it's green, not white.
    const interiorX = Math.round((colored.box!.left + colored.box!.right) / 2);
    const interiorY = Math.round((colored.box!.top + colored.box!.bottom) / 2);
    const interior = await pixelAt(coloredLayer.png, interiorX, interiorY);
    expect(interior.g).toBeGreaterThan(interior.r);
    expect(interior.g).toBeGreaterThan(interior.b);
  });
});

describe('overlayText', () => {
  let dir: string;
  let source: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ugc-text-'));
    source = path.join(dir, 'source.mp4');
    // Black 1080x1920 with a tone, long enough that the hook window (0-3s) and
    // the sizing window (a third of the way in, for 3s) do not overlap — so a
    // frame's ink identifies which block is on screen.
    const made = await runFfmpeg([
      '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30:d=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source,
    ]);
    expect(made.success).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('burns both blocks in, each within its own window', async () => {
    const out = path.join(dir, 'overlaid.mp4');
    const result = await overlayText({
      sourcePath: source,
      outputPath: out,
      hookText: AWKWARD_HOOK,
      sizing: { text: '5\'6", 140 lb, size L', placement: 'bottom-right' },
      tempDir: dir,
    });

    expect(result.success).toBe(true);
    expect(await probeDimensions(out)).toEqual({ width: WIDTH, height: HEIGHT });
    expect(Math.abs((await probeDuration(out)) - 12)).toBeLessThan(0.2);
    expect(await probeHasAudio(out)).toBe(true);

    // t=1s: hook on screen, in the upper half.
    const hookFrame = await frameInk(out, 1, dir);
    expect(hookFrame.count).toBeGreaterThan(1000);
    expect(hookFrame.box?.top).toBeLessThan(HEIGHT / 2);

    // t=3.5s: past the hook, before the sizing block — nothing on a black frame.
    expect((await frameInk(out, 3.5, dir)).count).toBeLessThan(200);

    // t=5s: a third of 12s is 4s, so the sizing block is up, bottom-right.
    const sizingFrame = await frameInk(out, 5, dir);
    expect(sizingFrame.count).toBeGreaterThan(300);
    expect(sizingFrame.box?.top).toBeGreaterThan(HEIGHT / 2);
    expect(sizingFrame.box?.left).toBeGreaterThan(WIDTH / 2);

    // t=9s: both windows closed.
    expect((await frameInk(out, 9, dir)).count).toBeLessThan(200);
  }, 240_000);

  it('renders the hook alone when there is no sizing overlay', async () => {
    const out = path.join(dir, 'hook-only.mp4');
    const result = await overlayText({
      sourcePath: source,
      outputPath: out,
      hookText: 'Fit check',
      tempDir: dir,
    });

    expect(result.success).toBe(true);
    expect(await probeDimensions(out)).toEqual({ width: WIDTH, height: HEIGHT });
    expect((await frameInk(out, 1, dir)).count).toBeGreaterThan(500);
    // Nothing appears later just because a layer was rendered "just in case".
    expect((await frameInk(out, 5, dir)).count).toBeLessThan(200);
  }, 180_000);

  it('still produces a playable video when there is no text at all', async () => {
    const out = path.join(dir, 'no-text.mp4');
    const result = await overlayText({
      sourcePath: source,
      outputPath: out,
      hookText: '',
      tempDir: dir,
    });

    expect(result.success).toBe(true);
    expect(await probeDimensions(out)).toEqual({ width: WIDTH, height: HEIGHT });
    expect(Math.abs((await probeDuration(out)) - 12)).toBeLessThan(0.2);
    expect(await probeHasAudio(out)).toBe(true);
  }, 120_000);

  it('keeps a source with no audio track working', async () => {
    const silent = path.join(dir, 'silent.mp4');
    expect((await runFfmpeg([
      '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30:d=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent,
    ])).success).toBe(true);

    const out = path.join(dir, 'silent-overlaid.mp4');
    const result = await overlayText({
      sourcePath: silent,
      outputPath: out,
      hookText: 'Fit check',
      tempDir: dir,
    });

    expect(result.success).toBe(true);
    expect((await frameInk(out, 1, dir)).count).toBeGreaterThan(500);
  }, 180_000);

  it('removes the PNGs it wrote, on success and on failure', async () => {
    const clean = await mkdtemp(path.join(tmpdir(), 'ugc-text-tidy-'));
    try {
      const out = path.join(clean, 'ok.mp4');
      expect((await overlayText({
        sourcePath: source,
        outputPath: out,
        hookText: AWKWARD_HOOK,
        sizing: { text: 'size L', placement: 'top-left' },
        tempDir: clean,
      })).success).toBe(true);
      expect(await readdir(clean)).toEqual(['ok.mp4']);

      const failed = path.join(clean, 'nope.mp4');
      const result = await overlayText({
        sourcePath: path.join(clean, 'missing.mp4'),
        outputPath: failed,
        hookText: AWKWARD_HOOK,
        tempDir: clean,
      });
      expect(result.success).toBe(false);
      // No stray PNGs, and no half-written output.
      expect(await readdir(clean)).toEqual(['ok.mp4']);
    } finally {
      await rm(clean, { recursive: true, force: true });
    }
  }, 180_000);

  it('returns a failure rather than throwing when the font cannot be loaded', async () => {
    const original = process.env.RENDER_FONT_PATH;
    process.env.RENDER_FONT_PATH = path.join(tmpdir(), 'definitely-not-a-font.ttf');
    const out = path.join(dir, 'no-font.mp4');
    try {
      const result = await overlayText({
        sourcePath: source,
        outputPath: out,
        hookText: 'Fit check',
        tempDir: dir,
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/font/i);
      expect(existsSync(out)).toBe(false);
    } finally {
      if (original === undefined) delete process.env.RENDER_FONT_PATH;
      else process.env.RENDER_FONT_PATH = original;
    }
  }, 60_000);

  it('reports a missing source without leaving an output behind', async () => {
    const out = path.join(dir, 'from-missing.mp4');
    const result = await overlayText({
      sourcePath: path.join(dir, 'missing.mp4'),
      outputPath: out,
      hookText: 'Fit check',
      tempDir: dir,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('missing.mp4');
    expect(existsSync(out)).toBe(false);
  }, 60_000);
});
