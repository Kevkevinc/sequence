import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { assTime, buildAssFile, escapeAssText, escapeFilterPath } from '@/lib/render/captions';
import { DEFAULT_CAPTION_SETTINGS } from '@/lib/render/captionSettings';
import { probeDimensions, runFfmpeg } from '@/lib/render/ffmpeg';
import { WIDTH, HEIGHT } from '@/lib/render/frame';

const CUES = [
  { text: 'hello everyone', startSeconds: 0, endSeconds: 1.2 },
  { text: 'this is a test', startSeconds: 1.5, endSeconds: 2.8 },
];

describe('assTime', () => {
  it('formats hours, minutes and centiseconds', () => {
    expect(assTime(0)).toBe('0:00:00.00');
    expect(assTime(1.23)).toBe('0:00:01.23');
    expect(assTime(61.5)).toBe('0:01:01.50');
    expect(assTime(3661.05)).toBe('1:01:01.05');
  });

  it('carries instead of emitting an impossible .100', () => {
    // Rounding 1.999 to centiseconds gives 100, which libass will not parse.
    expect(assTime(1.999)).toBe('0:00:02.00');
  });

  it('never emits a negative time', () => {
    expect(assTime(-5)).toBe('0:00:00.00');
  });
});

describe('escapeAssText', () => {
  it('strips braces, which would otherwise open an override block', () => {
    expect(escapeAssText('a {b} c')).toBe('a b c');
  });

  it('turns newlines into the ASS line break', () => {
    // A literal newline ends the event early and drops the rest of the caption.
    expect(escapeAssText('one\ntwo')).toBe('one\\Ntwo');
  });
});

describe('buildAssFile', () => {
  it('declares the frame size it was laid out against', () => {
    const ass = buildAssFile(CUES, DEFAULT_CAPTION_SETTINGS);
    expect(ass).toContain(`PlayResX: ${WIDTH}`);
    expect(ass).toContain(`PlayResY: ${HEIGHT}`);
  });

  it('names the font family libass has to match, not our internal id', () => {
    const ass = buildAssFile(CUES, { ...DEFAULT_CAPTION_SETTINGS, fontId: 'bebas' });
    // 'bebas' is this project's id; the TTF calls itself 'Bebas Neue', and that
    // is the only name libass will resolve.
    expect(ass).toContain('Bebas Neue');
    expect(ass).not.toMatch(/Style: Spoken,bebas,/);
  });

  it('writes colours in ASS byte order, not hex RGB', () => {
    // &HAABBGGRR — pure red is 0000FF, and getting this backwards is invisible
    // until a creator picks a colour that is not grey.
    const ass = buildAssFile(CUES, { ...DEFAULT_CAPTION_SETTINGS, textColor: '#FF0000' });
    expect(ass).toContain('&H000000FF');
  });

  it('emits one dialogue line per cue, in order', () => {
    const lines = buildAssFile(CUES, DEFAULT_CAPTION_SETTINGS)
      .split('\n')
      .filter((l) => l.startsWith('Dialogue:'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('hello everyone');
    expect(lines[0]).toContain('0:00:00.00,0:00:01.20');
    expect(lines[1]).toContain('this is a test');
  });

  it('drops a zero-length cue rather than emitting an undrawable event', () => {
    const lines = buildAssFile(
      [{ text: 'blink', startSeconds: 2, endSeconds: 2 }],
      DEFAULT_CAPTION_SETTINGS
    )
      .split('\n')
      .filter((l) => l.startsWith('Dialogue:'));
    expect(lines).toHaveLength(0);
  });
});

describe('the file ffmpeg actually renders', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ass-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is accepted by libass and burns onto video', async () => {
    // The real check: every field, order and escape in the generated file has
    // to satisfy libass, and a malformed one fails quietly by drawing nothing.
    const assPath = path.join(dir, 'cues.ass');
    const output = path.join(dir, 'burned.mp4');
    await writeFile(assPath, buildAssFile(CUES, DEFAULT_CAPTION_SETTINGS), 'utf8');

    // libass resolves the family name against this directory, so a font we
    // ship but ffmpeg cannot find would silently fall back to something else.
    const escaped = escapeFilterPath(assPath);
    const fontsDir = escapeFilterPath(path.join(process.cwd(), 'assets', 'fonts'));

    const result = await runFfmpeg([
      '-f', 'lavfi', '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:r=30:d=3`,
      '-vf', `subtitles='${escaped}':fontsdir='${fontsDir}'`,
      '-frames:v', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      output,
    ]);

    expect(result).toEqual({ success: true });
    expect(await probeDimensions(output)).toEqual({ width: WIDTH, height: HEIGHT });
  }, 120_000);
});
