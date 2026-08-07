import { readFile } from 'fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';

/**
 * What an uploaded inspiration image is, which decides how it is rendered.
 *
 * `person` is a photo of someone wearing the fit — the background is removed so
 * the figure floats over the footage. `listing` is a screenshot of a product
 * page, and must be left exactly as it is: cutting its background out would eat
 * the white card and the price, which *is* the content.
 */
export type InspirationImageKind = 'person' | 'listing';

export type Classification = {
  kind: InspirationImageKind;
  /** 0-1. Low values are the ones worth a second look on the confirm screen. */
  confidence: number;
  /** Why it decided, for the confirm screen and for debugging a bad call. */
  reason: string;
};

/** Analysed at this size: enough signal, and ~40x less work than a 4000px photo. */
const SAMPLE_WIDTH = 160;

/** Channel value at or above which a pixel counts as "paper white". */
const WHITE_LEVEL = 244;

/**
 * Screenshots are mostly a white card; photographs almost never are. Even a
 * shot against a white wall picks up enough gradient and shadow to fall short.
 */
const WHITE_FRACTION_THRESHOLD = 0.22;

/**
 * Distinct colours after quantising to a 5-bit-per-channel palette. A UI
 * screenshot is flat fills and text; a photograph is noise and gradients, and
 * runs an order of magnitude higher.
 */
const FLAT_PALETTE_THRESHOLD = 900;

/**
 * Decides whether an image is a person photo or a product-listing screenshot.
 *
 * Pixel statistics rather than a model: it is instant, costs no API quota, and
 * is explainable when it gets one wrong — which it will, occasionally, which is
 * why the upload flow shows the result for confirmation rather than acting on
 * it silently.
 */
export async function classifyInspirationImage(filePath: string): Promise<Classification> {
  const image = await loadImage(await readFile(filePath));
  const width = Math.min(SAMPLE_WIDTH, image.width);
  const height = Math.max(1, Math.round((image.height / image.width) * width));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  const palette = new Set<number>();
  let whitePixels = 0;
  const total = width * height;

  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r >= WHITE_LEVEL && g >= WHITE_LEVEL && b >= WHITE_LEVEL) whitePixels += 1;
    // 5 bits per channel: tolerant of sensor noise, still separates real hues.
    palette.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }

  const whiteFraction = whitePixels / total;
  const distinctColors = palette.size;

  const looksFlat = distinctColors < FLAT_PALETTE_THRESHOLD;
  const looksPapery = whiteFraction > WHITE_FRACTION_THRESHOLD;
  const kind: InspirationImageKind = looksFlat || looksPapery ? 'listing' : 'person';

  // Both signals agreeing is a confident call; one alone is the borderline case
  // the confirm screen exists for.
  const signals = (looksFlat ? 1 : 0) + (looksPapery ? 1 : 0);
  const confidence = kind === 'listing' ? (signals === 2 ? 0.9 : 0.6) : signals === 0 ? 0.85 : 0.6;

  return {
    kind,
    confidence,
    reason:
      `${Math.round(whiteFraction * 100)}% near-white, ${distinctColors} distinct colours` +
      ` (screenshot if >${Math.round(WHITE_FRACTION_THRESHOLD * 100)}% white or <${FLAT_PALETTE_THRESHOLD} colours)`,
  };
}
