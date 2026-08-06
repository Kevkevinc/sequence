import { rm } from 'fs/promises';
import { probeMedia, type MediaInfo, runFfmpeg } from '@/lib/render/ffmpeg';

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

/**
 * Crop-to-fill rather than letterbox: black bars read as amateur in short-form
 * UGC, and the footage is shot vertically anyway. `increase` scales until both
 * dimensions cover the frame, then the crop takes the centre.
 *
 * Rotation needs no filter here. ffmpeg autorotates on decode, so a phone clip
 * stored landscape with a 90-degree display matrix reaches this chain already
 * upright, and the re-encode drops the tag so nothing rotates it twice.
 */
const REFRAME =
  `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,` +
  `crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS}`;

/**
 * Quality of the per-cut intermediate.
 *
 * These parts are re-encoded once more when the hook text is burned in, so
 * whatever they lose is baked into the delivered video. Near-transparent here
 * (source phone footage is 25-40Mbps) keeps the second pass from compounding
 * a first-generation loss. The files are large but live only for the length of
 * one render, inside a temp directory that is deleted either way.
 */
const INTERMEDIATE_CRF = '11';

/**
 * Rounds a time to the nearest frame boundary.
 *
 * Video length can only ever be a whole number of frames: ask for 2.543s at
 * 30fps and ffmpeg emits 78 frames — 2.600s, not 2.543s. Snapping the start and
 * the requested duration to frames up front means every downstream number
 * (the `-t` passed to ffmpeg, the length concat expects) is one the video can
 * actually land on exactly, rather than one ffmpeg silently rounds away from.
 */
function snapToFrame(seconds: number): number {
  return Math.round(seconds * FPS) / FPS;
}

/**
 * Pins the video to exactly `seconds`.
 *
 * `-t` alone only bounds the *input*, and the frames arriving within that bound
 * still round up to the next frame boundary. `trim` cuts the surplus and
 * `setpts=N/FRAME_RATE/TB` renumbers what is left as consecutive frames from
 * zero, so the stream is the snapped length with no timestamp gaps.
 */
function videoChain(seconds: string): string {
  return `[0:v:0]${REFRAME},trim=duration=${seconds},setpts=N/FRAME_RATE/TB[v]`;
}

/** Fixed-point seconds: ffmpeg cannot parse the exponent form of a small float. */
function formatSeconds(value: number): string {
  return value.toFixed(6);
}

/**
 * Removes a half-written output.
 *
 * ffmpeg opens the output file before it initialises the filter graph, so a
 * graph or decode failure leaves a 0-byte file behind. Every guard below
 * promises "failed means nothing was written", and Task 3 iterates a directory
 * of parts, so the ffmpeg path has to keep that promise too. A cleanup failure
 * is swallowed: the render error is the one worth reporting.
 */
async function discardOutput(outputPath: string): Promise<void> {
  await rm(outputPath, { force: true }).catch(() => {});
}

/** Shortest of the durations that are actually known, or null when none are. */
function usablePicture(media: MediaInfo): number | null {
  const known = [media.video?.duration ?? null, media.containerDuration].filter(
    (value): value is number => value !== null
  );
  return known.length > 0 ? Math.min(...known) : null;
}

/**
 * Trims one cut out of a source clip and re-encodes it to the single format
 * every other cut shares: 1080x1920, 30fps, video-only.
 *
 * No audio: this product does not use source audio in v1 — AI-driven audio
 * editing (voiceover, music, etc.) is a future feature, not something this
 * pipeline can honestly reproduce yet (re-sequencing cuts the way the director
 * already does would otherwise chop a source clip's own audio into
 * disjointed snippets). Dropping it here, once, is simpler and more honest
 * than carrying silence through every downstream step.
 *
 * Uniformity is still the point for video — Task 3 joins the cuts with the
 * concat demuxer, which stream-copies and therefore only works when every
 * part agrees on codec, resolution and frame rate.
 */
export async function normaliseCut(input: {
  sourcePath: string;
  startSeconds: number;
  endSeconds: number;
  outputPath: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const requested = input.endSeconds - input.startSeconds;
  if (!Number.isFinite(requested) || requested <= 0) {
    return { success: false, error: `Cut has non-positive duration (${requested}s)` };
  }
  if (!Number.isFinite(input.startSeconds) || input.startSeconds < 0) {
    return { success: false, error: `Cut has an invalid start (${input.startSeconds}s)` };
  }

  let media: MediaInfo;
  try {
    media = await probeMedia(input.sourcePath);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (!media.video) {
    return { success: false, error: `Source has no video stream: ${input.sourcePath}` };
  }

  // Clamp against the *picture*, not the container. Container duration is the
  // longest stream, and a clip's audio (unused here) can outlast its video —
  // routine in real phone footage — so trusting the container would let a cut
  // run past the last real frame.
  const usableDuration = usablePicture(media);
  if (usableDuration === null) {
    return { success: false, error: `Could not read a duration from ${input.sourcePath}` };
  }
  if (input.startSeconds >= usableDuration) {
    return {
      success: false,
      error: `Cut starts at ${input.startSeconds}s, past the end of ${usableDuration}s of picture`,
    };
  }

  const start = snapToFrame(input.startSeconds);
  const duration = snapToFrame(Math.min(input.endSeconds, usableDuration) - start);
  // Below one frame the video stream would come out empty, which concatenation
  // cannot copy — better to reject the cut than to emit a part with no picture.
  if (duration < 1 / FPS) {
    return { success: false, error: `Cut is shorter than one frame (${duration}s)` };
  }

  const seconds = formatSeconds(duration);
  // -ss before -i seeks fast; putting it after -i would decode from zero every
  // time, which is slow on a 36s source cut near its end.
  //
  // -xerror: without an audio stream to also decode, a corrupted video frame
  // no longer reliably aborts the whole command — libx264's decoder conceals
  // errors (a garbage-but-present frame) rather than failing, so a corrupt
  // source would otherwise silently produce a broken-looking cut instead of
  // the clear failure this function promises callers.
  const result = await runFfmpeg([
    '-xerror',
    '-ss', formatSeconds(start), '-t', seconds, '-i', input.sourcePath,
    '-filter_complex', videoChain(seconds),
    '-map', '[v]',
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', INTERMEDIATE_CRF,
    '-pix_fmt', 'yuv420p',
    input.outputPath,
  ]);

  if (!result.success) await discardOutput(input.outputPath);
  return result;
}
