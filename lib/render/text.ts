import { rm, writeFile } from 'fs/promises';
import path from 'path';
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import { OVERLAY_PLACEMENTS, type OverlayPlacement } from '@/lib/editPlan';
import { getEnvWithDefault } from '@/lib/env';
import { probeMedia, runFfmpeg } from '@/lib/render/ffmpeg';

const WIDTH = 1080;
const HEIGHT = 1920;

/**
 * The placements the director may choose, and the only ones renderable here.
 *
 * Re-exported from the shared EditPlan contract rather than restated, so the
 * planner and the renderer cannot drift. `renderSizingLayer` still falls back
 * rather than throwing if an unknown value reaches it, since the database column
 * is plain text and could hold a row written before this list changed.
 */
export const SIZING_PLACEMENTS = OVERLAY_PLACEMENTS;

export type SizingPlacement = OverlayPlacement;

/** Bold sans, committed to the repo. See the note on {@link registerFont}. */
const FONT_FAMILY = 'UgcHookFont';
const DEFAULT_FONT_FILE = path.join(process.cwd(), 'assets', 'fonts', 'Roboto-Bold.ttf');

const HOOK = {
  fontSize: 68,
  lineHeightRatio: 1.18,
  /** Leaves 60px of breathing room each side for the outline and the frame. */
  maxWidth: WIDTH - 120,
  /** Upper third, clear of a phone's status bar and any platform chrome. */
  top: Math.round(HEIGHT * 0.14),
  /** Seconds the hook stays up, from the start. */
  seconds: 3,
};

const SIZING = {
  fontSize: 40,
  lineHeightRatio: 1.2,
  margin: 60,
  maxWidth: WIDTH - 120,
  /** Seconds the block stays up, starting a third of the way in. */
  seconds: 3,
};

/** A drawn PNG layer and the height of the text block inside it. */
export type TextLayer = { png: Buffer; blockHeight: number };

/** The font file already loaded, so repeat renders do not re-read it. */
let registeredFrom: string | null = null;

/**
 * Loads the committed font by path, under our own family name.
 *
 * Explicitly, never via fontconfig: `C:/Windows/Fonts` does not exist in
 * production, font availability differs per machine, and a missing family falls
 * back silently to whatever the platform considers a default — which on Windows
 * meant a serif. Registering by path makes the rendering identical everywhere,
 * and a missing file is a loud failure rather than a wrong-looking video.
 */
function registerFont(): void {
  const fontPath = getEnvWithDefault('RENDER_FONT_PATH', DEFAULT_FONT_FILE);
  if (registeredFrom === fontPath) return;
  if (GlobalFonts.registerFromPath(fontPath, FONT_FAMILY) === null) {
    throw new Error(`Could not load the overlay font from ${fontPath}`);
  }
  registeredFrom = fontPath;
}

/**
 * Breaks text into lines that fit `maxWidth`, measuring the real glyphs.
 *
 * ffmpeg's drawtext cannot wrap at all, which is one of several reasons it is
 * not used here: a 73-character hook would run off both edges of the frame.
 */
function wrap(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // A single word wider than the frame (a URL, or a wall of one character)
    // has no space to break on, so break it mid-word rather than let it run off
    // the edge.
    line = word;
    while (ctx.measureText(line).width > maxWidth && line.length > 1) {
      let fitted = line.length - 1;
      while (fitted > 1 && ctx.measureText(line.slice(0, fitted)).width > maxWidth) fitted -= 1;
      lines.push(line.slice(0, fitted));
      line = line.slice(fitted);
    }
  }

  if (line) lines.push(line);
  return lines;
}

/** Default when a style does not specify its own color. */
const DEFAULT_TEXT_COLOR = '#ffffff';

type LayerOptions = {
  text: string;
  fontSize: number;
  lineHeightRatio: number;
  maxWidth: number;
  align: 'left' | 'center' | 'right';
  /** Horizontal anchor, interpreted according to `align`. */
  x: number;
  /** Top of the block, or a function of its height for bottom-anchored blocks. */
  y: number | ((blockHeight: number) => number);
  textColor: string;
};

/**
 * Draws one text block onto a transparent 1080x1920 canvas.
 *
 * White fill over a heavy dark stroke: the footage underneath is arbitrary, and
 * white-on-white is the failure mode that makes a hook unreadable. `lineJoin:
 * round` keeps the stroke from growing spikes at sharp glyph corners.
 */
function renderLayer(options: LayerOptions): TextLayer {
  registerFont();

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.font = `${options.fontSize}px "${FONT_FAMILY}"`;
  ctx.textAlign = options.align;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.92)';
  ctx.lineWidth = Math.round(options.fontSize * 0.22);
  ctx.fillStyle = options.textColor;

  const lines = wrap(ctx, options.text, options.maxWidth);
  const lineHeight = Math.round(options.fontSize * options.lineHeightRatio);
  const blockHeight = lines.length * lineHeight;
  const top = typeof options.y === 'number' ? options.y : options.y(blockHeight);

  for (const [index, line] of lines.entries()) {
    const y = top + index * lineHeight;
    ctx.strokeText(line, options.x, y);
    ctx.fillText(line, options.x, y);
  }

  return { png: canvas.toBuffer('image/png'), blockHeight };
}

/** The hook: large, centred, in the upper third. */
export function renderHookLayer(text: string, options: { textColor?: string } = {}): TextLayer {
  return renderLayer({
    text,
    fontSize: HOOK.fontSize,
    lineHeightRatio: HOOK.lineHeightRatio,
    maxWidth: HOOK.maxWidth,
    align: 'center',
    x: WIDTH / 2,
    y: HOOK.top,
    textColor: options.textColor ?? DEFAULT_TEXT_COLOR,
  });
}

/** The sizing block: smaller, in whichever corner the director chose. */
export function renderSizingLayer(
  text: string,
  placement: SizingPlacement,
  options: { textColor?: string } = {}
): TextLayer {
  const known = SIZING_PLACEMENTS.includes(placement) ? placement : 'bottom-left';
  const [vertical, horizontal] = known.split('-');

  const align = horizontal === 'center' ? 'center' : (horizontal as 'left' | 'right');
  const x =
    horizontal === 'left' ? SIZING.margin
      : horizontal === 'right' ? WIDTH - SIZING.margin
      : WIDTH / 2;

  return renderLayer({
    text,
    fontSize: SIZING.fontSize,
    lineHeightRatio: SIZING.lineHeightRatio,
    maxWidth: SIZING.maxWidth,
    align,
    x,
    // A bottom-anchored block cannot know its top until it knows how many lines
    // it wrapped onto, so the caller supplies the top as a function of that.
    y: vertical === 'top'
      ? SIZING.margin
      : (blockHeight: number) => HEIGHT - SIZING.margin - blockHeight,
    textColor: options.textColor ?? DEFAULT_TEXT_COLOR,
  });
}

/** Fixed-point seconds: ffmpeg cannot parse the exponent form of a small float. */
function formatSeconds(value: number): string {
  return value.toFixed(3);
}

async function discardOutput(outputPath: string): Promise<void> {
  await rm(outputPath, { force: true }).catch(() => {});
}

type PreparedLayer = { file: string; from: number; to: number };

/**
 * How long the pop-up inspiration photo stays up, matching the hook's window.
 *
 * Exported so tests can assert against the exact box the filter graph draws
 * (and its border) instead of duplicating these numbers.
 */
export const INSPIRATION_IMAGE = {
  seconds: 4,
  /** Fixed thumbnail box in the upper-left, clear of the frame edge. */
  width: 320,
  height: 480,
  margin: 40,
};

/**
 * Burns the hook and the sizing overlay into a video.
 *
 * Each block is drawn to its own transparent PNG and composited with an
 * `overlay` filter, so each gets its own visibility window: the hook for the
 * first three seconds, the sizing block for three seconds starting a third of
 * the way in — late enough to land on try-on footage rather than compete with
 * the hook.
 *
 * ffmpeg never sees the text, only a picture of it. That is deliberate: the
 * bundled ffmpeg 6.1.1's `drawtext` silently truncates at the first colon,
 * drops apostrophes, cannot wrap, and falls back to a serif on Windows — it
 * rendered the hook "POV: you just found the streetwear zip-up hoodie everyone
 * is talking about" as the three characters "POV". A wrong video that looks
 * fine is worse than an error, so there is no escaping surface here at all.
 *
 * Never throws; a failure is an outcome the caller records against the job.
 */
export async function overlayText(input: {
  sourcePath: string;
  outputPath: string;
  hookText: string;
  sizing?: { text: string; placement: SizingPlacement } | null;
  tempDir: string;
  textColor?: string;
  inspirationImagePath?: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const layers: PreparedLayer[] = [];
  const unique = `${path.basename(input.outputPath, path.extname(input.outputPath))}-${process.pid}`;
  const imageLayers: { file: string; from: number; to: number }[] = [];

  try {
    // Each layer is recorded *before* it is written, so the cleanup below also
    // removes a PNG whose write failed halfway through.
    if (input.hookText.trim()) {
      const png = renderHookLayer(input.hookText, { textColor: input.textColor }).png;
      const file = path.join(input.tempDir, `hook-${unique}.png`);
      layers.push({ file, from: 0, to: HOOK.seconds });
      await writeFile(file, png);
    }

    if (input.sizing?.text.trim()) {
      const png = renderSizingLayer(input.sizing.text, input.sizing.placement, {
        textColor: input.textColor,
      }).png;
      // The window is placed relative to the finished video's length, so the
      // block lands a third of the way in whatever the edit turned out to be.
      const duration =
        (await probeMedia(input.sourcePath)).containerDuration ?? SIZING.seconds * 3;
      const from = duration / 3;
      const file = path.join(input.tempDir, `sizing-${unique}.png`);
      layers.push({ file, from, to: from + SIZING.seconds });
      await writeFile(file, png);
    }

    if (input.inspirationImagePath) {
      imageLayers.push({ file: input.inspirationImagePath, from: 0, to: INSPIRATION_IMAGE.seconds });
    }

    // Nothing to draw: copy the streams rather than spend a re-encode, and a
    // lossless one at that.
    if (layers.length === 0 && imageLayers.length === 0) {
      const copied = await runFfmpeg([
        '-i', input.sourcePath,
        '-c', 'copy',
        '-movflags', '+faststart',
        input.outputPath,
      ]);
      if (!copied.success) await discardOutput(input.outputPath);
      return copied;
    }

    // [0:v] is the footage; each PNG/photo is an input after it. `enable` gates
    // the overlay to its window; outside it the filter passes the frame
    // straight through. A single-frame input holds for the whole video thanks
    // to overlay's default `eof_action=repeat`.
    //
    // Text layers are full-frame PNGs, overlaid at 0,0. The image layer is an
    // arbitrary-sized photo, so it is scaled to a fixed thumbnail box first and
    // overlaid in the upper-left corner — a different position and a different
    // input type, but the same "extra input, same enable-window overlay" chain
    // the text layers already use.
    const allInputs = [...layers.map((l) => l.file), ...imageLayers.map((l) => l.file)];
    const inputs = allInputs.flatMap((file) => ['-i', file]);

    const filters: string[] = [];
    let current = '[0:v]';
    let inputIndex = 1;

    for (const layer of layers) {
      const label = `[t${inputIndex}]`;
      const window = `between(t,${formatSeconds(layer.from)},${formatSeconds(layer.to)})`;
      filters.push(`${current}[${inputIndex}:v]overlay=0:0:enable='${window}'${label}`);
      current = label;
      inputIndex += 1;
    }

    // v1 scope is one inspiration photo per job, so this loop runs at most
    // once — meaning the border step below, when it runs, is always the last
    // filter in the chain and can label its output `[v]` directly rather than
    // going through the generic text-layer relabelling below.
    let chainEndsAtV = false;

    for (const layer of imageLayers) {
      const scaled = `[img${inputIndex}]`;
      filters.push(
        `[${inputIndex}:v]scale=${INSPIRATION_IMAGE.width}:${INSPIRATION_IMAGE.height}${scaled}`
      );
      const label = `[t${inputIndex}]`;
      const window = `between(t,${formatSeconds(layer.from)},${formatSeconds(layer.to)})`;
      filters.push(
        `${current}${scaled}overlay=${INSPIRATION_IMAGE.margin}:${INSPIRATION_IMAGE.margin}:enable='${window}'${label}`
      );
      current = label;
      inputIndex += 1;

      // The brief calls for the thumbnail to read as a bordered photo card,
      // not a bare rectangle of pixels — so draw a white outline around it in
      // the same box, gated by the same enable window as the overlay above.
      // `t=4` (not `t=fill`) draws a 4px unfilled outline rather than a filled
      // box, confirmed against this project's bundled ffmpeg-static binary
      // (`ffmpeg -h filter=drawbox`, "t / thickness: set the box thickness",
      // default "3" — fill requires the literal string "fill", not a number).
      filters.push(
        `${current}drawbox=x=${INSPIRATION_IMAGE.margin}:y=${INSPIRATION_IMAGE.margin}:w=${INSPIRATION_IMAGE.width}:h=${INSPIRATION_IMAGE.height}:color=white:t=4:enable='${window}'[v]`
      );
      chainEndsAtV = true;
    }

    // The last filter's output must be labelled `[v]` for `-map` below. The
    // image-layer loop above already does this itself (see `chainEndsAtV`);
    // otherwise the last text layer's generated label is relabelled here.
    const chain = chainEndsAtV
      ? filters.join(';')
      : filters.join(';').replace(new RegExp(`\\[t${inputIndex - 1}\\]$`), '[v]');

    const result = await runFfmpeg([
      '-i', input.sourcePath,
      ...inputs,
      '-filter_complex', chain,
      '-map', '[v]',
      // Optional: a source with no audio must not fail the whole overlay pass.
      // The audio is untouched here, so copying keeps it bit-identical to the
      // normalised parts rather than putting it through a second AAC encode.
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      // This is the file the creator downloads and the browser streams, so the
      // index belongs at the front.
      '-movflags', '+faststart',
      input.outputPath,
    ]);

    if (!result.success) await discardOutput(input.outputPath);
    return result;
  } catch (error) {
    // A missing font, an unwritable temp directory, or a source ffprobe cannot
    // read. The contract is a result, never an exception.
    await discardOutput(input.outputPath);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    for (const layer of layers) {
      await rm(layer.file, { force: true }).catch(() => {});
    }
    // Note: imageLayers' files belong to the caller (a downloaded temp clip in
    // renderPlan's case) and are not removed here.
  }
}
