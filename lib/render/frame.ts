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

export type RenderQuality = '1080p' | '4k';

/**
 * Everything the render layer needs to know about one output resolution.
 *
 * Resolution used to be the two module constants above, read directly wherever
 * a pixel value was needed. That is exactly right when there is one output
 * size; it stops working the moment a creator can pick per job. So the same
 * numbers are bundled here and threaded through the render functions instead —
 * `frame.ts` stays the one place a resolution is defined, but a job now carries
 * *which* one.
 *
 * `scaled` is the per-profile twin of {@link scaled}: a metric authored at the
 * 1080-wide reference frame, scaled to this profile. At 1080p it is the
 * identity (width === reference width), which is why the 1080p profile
 * reproduces the old constants exactly — every `scaled(n)` was already just `n`.
 *
 * The CRF pair comes straight from the measured comparison in the block above:
 * 1080p delivers at 13 over an 11 intermediate; 4K at 14 over a 12, the point
 * on that table where the extra resolution stops paying for itself.
 */
export type QualityProfile = {
  quality: RenderQuality;
  width: number;
  height: number;
  fps: number;
  /** CRF for the throwaway per-cut intermediate (silent pipeline only). */
  intermediateCrf: string;
  /** CRF for the delivered encode. */
  finalCrf: string;
  /**
   * Extra ffmpeg args spliced into every libx264 command for this profile,
   * right after the CRF.
   *
   * This is where 4K's *render* memory is kept in check. Left to itself, libx264
   * opens roughly 1.5 frame-threads per CPU, and in a container it sees every
   * host core — so a 4K encode fans out to a couple dozen threads, each holding
   * its own full 2160×3840 frame, and peaks around 2.5GB. Sharing the box with
   * the ~1GB worker process, that is an OOM-kill (measured: renders died with
   * SIGKILL at the final encode). Capping threads brings the same encode to
   * ~1.1GB; the low lookahead trims a little more. 1080p frames are a quarter
   * the size and never came close, so it keeps ffmpeg's fast defaults.
   *
   * The *download* memory limit — how big the delivered file may be before the
   * phone cannot save it — is a separate, per-clip concern; see
   * {@link deliveryBitrateArgs}.
   */
  encodeArgs: string[];
  /** Scales a length authored at the 1080-wide reference frame to this profile. */
  scaled(lengthAtReferenceWidth: number): number;
};

function makeProfile(
  quality: RenderQuality,
  width: number,
  height: number,
  intermediateCrf: string,
  finalCrf: string,
  encodeArgs: string[]
): QualityProfile {
  return {
    quality,
    width,
    height,
    fps: FPS,
    intermediateCrf,
    finalCrf,
    encodeArgs,
    scaled: (lengthAtReferenceWidth) =>
      Math.round((lengthAtReferenceWidth * width) / REFERENCE_WIDTH),
  };
}

export const QUALITY_PROFILES: Record<RenderQuality, QualityProfile> = {
  // Exactly the previous behaviour: 1080×1920, the CRFs the render layer
  // shipped, and ffmpeg's own thread defaults — 1080p never threatened memory.
  '1080p': makeProfile('1080p', WIDTH, HEIGHT, '11', '13', []),
  // Native 4K portrait, at the CRFs the frame-size investigation measured, with
  // libx264 held to 2 threads and a short lookahead so the encode fits in RAM.
  // The delivered file's size cap is applied per clip at encode time, not here;
  // see {@link deliveryBitrateArgs}.
  '4k': makeProfile('4k', 2160, 3840, '12', '14', [
    '-threads', '2',
    '-x264-params', 'sync-lookahead=0:rc-lookahead=10',
  ]),
};

/**
 * The largest a delivered file may be before the installed app cannot save it.
 *
 * To save a video the PWA fetches the whole thing into memory and hands it to
 * the iOS share sheet; a file past a few hundred MB buffers over WebKit's
 * per-tab ceiling and kills the tab mid-download ("a problem repeatedly
 * occurred"), reliably after a clip or two as the bytes stack up. Kept well
 * under that, with headroom for buffering several in a row.
 */
export const DELIVERY_TARGET_BYTES = 150_000_000;

/**
 * The best 4K bitrate spent even on a short clip. 40 Mbps is a good rate for
 * 4K/30 — visibly sharper than the 1080p TikTok ultimately delivers — and short
 * clips at this rate are comfortably under {@link DELIVERY_TARGET_BYTES}, so the
 * common case pays no quality tax at all.
 */
export const DELIVERY_MAX_MBPS = 40;

/**
 * The `-maxrate`/`-bufsize` VBV cap for the *delivered* encode, chosen per clip.
 *
 * A near-lossless `-crf 14` 4K encode rides ~114 Mbps: a 30s clip is ~430MB and
 * a 60s one (the longest a creator can ask for) ~860MB — far too big for the
 * phone to save, which is what crashed the download. A single flat bitrate can't
 * fix that: one low enough to keep a 60s clip saveable would needlessly starve
 * the 30s clip that is most of the traffic. So the ceiling is picked from the
 * clip's own length to hold the file near {@link DELIVERY_TARGET_BYTES} — every
 * clip up to ~30s gets the full {@link DELIVERY_MAX_MBPS}, and only longer ones
 * are throttled (a 60s clip lands ~20 Mbps) to stay under the limit.
 *
 * 1080p is a quarter the pixels and never threatened the ceiling, so it is left
 * to CRF's own sizing and gets no cap.
 */
export function deliveryBitrateArgs(profile: QualityProfile, seconds: number): string[] {
  if (profile.quality !== '4k' || !Number.isFinite(seconds) || seconds <= 0) return [];
  const fitsTargetMbps = (DELIVERY_TARGET_BYTES * 8) / (seconds * 1_000_000);
  const mbps = Math.max(8, Math.min(DELIVERY_MAX_MBPS, Math.floor(fitsTargetMbps)));
  return ['-maxrate', `${mbps}M`, '-bufsize', `${Math.round(mbps * 1.25)}M`];
}

/** The default every un-updated caller and every pre-4K job renders at. */
export const DEFAULT_PROFILE = QUALITY_PROFILES['1080p'];

/** Resolves a stored `jobs.quality` value to its profile, defaulting to 1080p. */
export function profileForQuality(quality: string | null | undefined): QualityProfile {
  return quality === '4k' ? QUALITY_PROFILES['4k'] : QUALITY_PROFILES['1080p'];
}
