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
 * 2160x3840 matches what testers actually upload. Every raw clip measured from
 * the live bucket is 3840x2160 with a -90 display matrix — i.e. exactly
 * 2160x3840 once ffmpeg autorotates — so `scale` here is now a no-op and the
 * footage reaches the encoder without being resampled at all.
 *
 * Measured on a real 4K tester clip, each candidate downscaled back to 1080p
 * and compared (SSIM) against a high-precision downscale of the source, which
 * is the best any pipeline could deliver:
 *
 *   1080x1920   0.9875   1.0x render time   (previous setting)
 *   1440x2560   0.9910   1.7x
 *   2160x3840   0.9944   3.7x
 *
 * The 1080p loss is visible, not just numeric: on canvas or knit the weave
 * dissolves into a smooth smear, which is the "blurry / staticy" a tester
 * reported. Note the scaler was never the problem — lanczos measured best of
 * five tested (bicubic .9891, spline .9902, area .9886, bilinear .9771).
 *
 * Changing the two constants below is the whole change; every caption metric
 * scales from them. Dropping to 1440x2560 buys back roughly half the render
 * time for a third of the quality gain if throughput ever matters more.
 */
export const WIDTH = 2160;
export const HEIGHT = 3840;

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
