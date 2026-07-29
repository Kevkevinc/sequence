import { rm } from 'fs/promises';
import { probeMedia, type MediaInfo, runFfmpeg } from '@/lib/render/ffmpeg';

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const SAMPLE_RATE = 44100;
const CHANNELS = 2;

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
  `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
  `crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS}`;

/**
 * Rounds a time to the nearest frame boundary.
 *
 * Video length can only ever be a whole number of frames: ask for 2.543s at
 * 30fps and ffmpeg emits 78 frames — 2.600s — while the audio chain below trims
 * to precisely 2.543s. That 57ms of surplus picture is silent, and the concat
 * demuxer turns each one into an audible dropout at the splice ("gap 0.0458s
 * before pts 2.6000"), so a 9-cut variation collects 8 of them. Snapping both
 * the start and the duration to frames first means the length the audio is
 * trimmed to is one the video can actually land on.
 */
function snapToFrame(seconds: number): number {
  return Math.round(seconds * FPS) / FPS;
}

/**
 * Pins the audio to exactly `seconds`, whatever it started as.
 *
 * `apad` covers a track that runs short of the video and `atrim` cuts one that
 * runs long; together they guarantee audio and video are the same length.
 * Without that the parts drift against each other and every concatenated cut
 * pushes the desync further.
 */
function audioChain(label: string, seconds: string): string {
  return `[${label}]aresample=async=1:first_pts=0,apad,atrim=duration=${seconds},asetpts=N/SR/TB[a]`;
}

/**
 * Pins the video to exactly `seconds` too.
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
 * every other cut shares: 1080x1920, 30fps, stereo 44.1kHz AAC, with video and
 * audio the same length to within a frame.
 *
 * Uniformity is the whole point — Task 3 joins the cuts with the concat
 * demuxer, which stream-copies and therefore only works when every part agrees
 * on codec, resolution, frame rate and audio parameters, and only sounds right
 * when no part's audio stops before its picture does.
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

  // One probe answers everything the command needs. A source with no audio
  // still has to yield an audio track, or concatenation drops the cut's slot in
  // the audio timeline and everything after it desyncs — and probing for the
  // stream, then picking one of two plain command shapes, beats mixing the real
  // track with silence: `amix` needs both inputs to exist, and ffmpeg rejects
  // the whole filtergraph ("matches no streams") when they do not.
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
  // longest stream, so on a clip whose audio outlasts its video — routine in
  // real phone footage — trusting it would pad audio out past the last frame
  // and reintroduce exactly the desync this function exists to prevent.
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

  // Snap both ends to frame boundaries so the audio is trimmed to a length the
  // video can land on exactly.
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
  const trimmedSource = ['-ss', formatSeconds(start), '-t', seconds, '-i', input.sourcePath];
  const hasAudio = media.audio !== null;
  const silenceInput = hasAudio
    ? []
    : [
        '-f', 'lavfi',
        '-t', seconds,
        '-i', `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE}`,
      ];

  const result = await runFfmpeg([
    ...trimmedSource,
    ...silenceInput,
    '-filter_complex',
    `${videoChain(seconds)};${audioChain(hasAudio ? '0:a:0' : '1:a:0', seconds)}`,
    '-map', '[v]',
    '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
    input.outputPath,
  ]);

  if (!result.success) await discardOutput(input.outputPath);
  return result;
}
