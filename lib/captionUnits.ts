/**
 * Caption size, in the unit a creator sees.
 *
 * Stored sizes are pixels at the renderer's 1080px reference width, which is
 * the right unit for the renderer and a meaningless one on screen: "36" reads
 * as enormous next to a 216px preview. The interface shows points instead, on
 * the 8 to 24 scale the design specifies, and converts at the boundary so only
 * one unit ever reaches storage.
 */

const PX_PER_PT = 3;

export const MIN_CAPTION_PT = 8;
export const MAX_CAPTION_PT = 24;

export function toPt(px: number): number {
  return Math.round(px / PX_PER_PT);
}

export function fromPt(pt: number): number {
  return pt * PX_PER_PT;
}
