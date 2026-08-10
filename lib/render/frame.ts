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
 * Held at 1080x1920, which is also what TikTok delivers. Raising it was
 * investigated at length after a tester reported the output looking soft and
 * "staticy" beside videos he cuts by hand, and the investigation landed
 * somewhere other than where it started — worth recording so it isn't redone.
 *
 * Sources are 3840x2160 with a -90 display matrix (2160x3840 once ffmpeg
 * autorotates), so this frame does discard three quarters of the incoming
 * pixels. Measured end-to-end in the shape this pipeline actually runs (cut
 * pass, then text pass), against the 4K source, on a deliberately hard clip —
 * handheld, textured fabric and stucco. Error is 1-SSIM, lower is better:
 *
 *   1080x1920  crf 11/15   1.0x   149MB/30s   0.0249   (what testers saw)
 *   1440x2560  crf 11/13   1.5x   295MB/30s   0.0135
 *   2160x3840  crf 14/16   4.1x   336MB/30s   0.0107
 *   2160x3840  crf 12/14   5.2x   427MB/30s   0.0083
 *
 * Raising the frame looks like the fix in that table, but most of that gap is
 * not the frame size. Holding resolution at 1080 and only moving the final
 * pass from crf 15 to 13 recovers most of the visible texture on its own, and
 * a mild {@link DOWNSCALE_SHARPEN} restores the rest — see the strip in
 * `local-videos/Test 11 …/sharpen-test.png`, where 1080p tuned that way is
 * hard to tell from 1440p at 1:1. Since delivery is 1080p regardless, detail
 * that only exists above it buys nothing but render time and upload size.
 *
 * Two things that are *not* the lever, recorded so nobody re-derives them:
 * the scaler (lanczos measured best of five — spline .9902, bicubic .9891,
 * area .9886, bilinear .9771), and bitrate on its own (1080p at 294Mbps
 * lossless still trails a tuned 1440p at 84Mbps).
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
