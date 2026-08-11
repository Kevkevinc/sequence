/**
 * Where each line of a text block goes, independent of what is drawing it.
 *
 * This exists so the on-screen preview and the rendered video cannot disagree.
 * Both @napi-rs/canvas (the renderer) and Chrome (the preview) measure text
 * with Skia, so given the same font file, the same size and the same wrapping
 * rules they produce the same line breaks — but only if they actually run the
 * same rules. Duplicating the wrap in the browser would be a second
 * implementation to drift, and a preview that lies about where the text lands
 * is worse than no preview.
 *
 * Deliberately free of any canvas import. The caller passes a `measure`
 * function, which is `ctx.measureText(t).width` in both worlds.
 */

export type MeasureText = (text: string) => number;

export type TextBlockLayout = {
  lines: string[];
  /** Total height of the block, used to centre it vertically. */
  blockHeight: number;
  lineHeight: number;
};

/**
 * Breaks `text` into lines that fit `maxWidth`.
 *
 * Words longer than the line are split mid-word rather than allowed to run off
 * the frame: a hook of unbroken characters is rare but a caption bleeding off
 * both edges is unusable, and there is no better break to find.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: MeasureText
): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth || !line) {
        // A single word wider than the line still starts the line; it is
        // broken below rather than dropped.
        line = candidate;
        continue;
      }
      lines.push(line);
      line = word;
    }
    if (line) lines.push(line);
  }

  // Second pass: any line still too wide is one long word, split by character.
  const fitted: string[] = [];
  for (const line of lines) {
    if (measure(line) <= maxWidth) {
      fitted.push(line);
      continue;
    }
    let current = '';
    for (const char of line) {
      if (current && measure(current + char) > maxWidth) {
        fitted.push(current);
        current = char;
      } else {
        current += char;
      }
    }
    if (current) fitted.push(current);
  }

  return fitted;
}

/** Lines, line height and total block height for a piece of text. */
export function layoutTextBlock(input: {
  text: string;
  fontSize: number;
  lineHeightRatio: number;
  maxWidth: number;
  measure: MeasureText;
}): TextBlockLayout {
  const lines = wrapText(input.text, input.maxWidth, input.measure);
  const lineHeight = Math.round(input.fontSize * input.lineHeightRatio);
  return { lines, lineHeight, blockHeight: lines.length * lineHeight };
}

/**
 * Turns a centre expressed as a fraction of the frame into the pixel anchor a
 * canvas needs, keeping the whole block inside the frame.
 *
 * Clamping is what makes a free-positioned caption safe: a creator dragging a
 * block towards a corner would otherwise push half of it off-screen, and a
 * caption that is 80% visible reads as a bug rather than a choice. The block is
 * pushed back in rather than the drag being blocked, so the gesture still feels
 * continuous.
 *
 * `x` is the horizontal centre because both blocks are centre-aligned; `top` is
 * returned rather than a centre because that is what `fillText` with a `top`
 * baseline wants.
 */
export function anchorBlock(input: {
  centreXFraction: number;
  centreYFraction: number;
  blockWidth: number;
  blockHeight: number;
  frameWidth: number;
  frameHeight: number;
  /** Keeps the block off the very edge, where the outline would be clipped. */
  marginPx: number;
}): { x: number; top: number } {
  const halfWidth = input.blockWidth / 2;
  const minX = input.marginPx + halfWidth;
  const maxX = input.frameWidth - input.marginPx - halfWidth;
  // When the block is wider than the frame allows, centre it rather than
  // letting the clamp invert and pin it to an edge.
  const x =
    minX > maxX
      ? input.frameWidth / 2
      : Math.min(Math.max(input.centreXFraction * input.frameWidth, minX), maxX);

  const minTop = input.marginPx;
  const maxTop = input.frameHeight - input.marginPx - input.blockHeight;
  const desiredTop = input.centreYFraction * input.frameHeight - input.blockHeight / 2;
  const top = minTop > maxTop ? minTop : Math.min(Math.max(desiredTop, minTop), maxTop);

  return { x: Math.round(x), top: Math.round(top) };
}

/** Width of the widest line, which is the block's own width. */
export function blockWidth(lines: string[], measure: MeasureText): number {
  return lines.reduce((widest, line) => Math.max(widest, measure(line)), 0);
}
