/**
 * The one place the output frame size is decided.
 *
 * Was hardcoded as 1080x1920 in both the cut normaliser and the text overlay,
 * which meant the two could drift and neither could be changed without hunting
 * pixel values through the other.
 *
 * The size matters more than it looks. A creator filming 4K on a phone and
 * editing in TikTok gets one downscale-and-encode, performed by TikTok from his
 * pristine source. Rendering to 1080p first gives TikTok an already-compressed
 * 1080p source to re-encode, so the result is softer than the videos he makes
 * by hand — which is exactly what a tester reported, and why no amount of
 * bitrate at 1080p closed the gap. Matching the source resolution hands TikTok
 * the same thing his own workflow does.
 *
 * Held at 1080p for now regardless, per creator direction to take the fastest
 * option. Measured on one real edit plan so the trade is a known quantity
 * rather than a guess:
 *
 *   1080x1920   crf 15 / slow     36.7 Mbps   135MB   160s per variation
 *   2160x3840   crf 18 / medium   60.8 Mbps   224MB   303s per variation
 *
 * Changing the two constants below is the whole change; every caption metric
 * scales from them.
 */
export const WIDTH = 1080;
export const HEIGHT = 1920;

export const FPS = 30;

/**
 * The width every text metric below was originally tuned against.
 *
 * Font sizes and paddings are expressed at this width and scaled to the real
 * frame, so changing WIDTH moves the caption geometry with it instead of
 * leaving 42px type marooned on a 2160px-wide canvas.
 */
const REFERENCE_WIDTH = 1080;

/** Scales a length authored against {@link REFERENCE_WIDTH} to the real frame. */
export function scaled(lengthAtReferenceWidth: number): number {
  return Math.round((lengthAtReferenceWidth * WIDTH) / REFERENCE_WIDTH);
}
