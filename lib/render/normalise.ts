import { probeHasAudio, runFfmpeg } from '@/lib/render/ffmpeg';

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
 * Pins the audio to exactly `seconds`, whatever it started as.
 *
 * `apad` covers a track that runs short of the video (common when a cut lands
 * past the last audio frame) and `atrim` cuts one that runs long; together they
 * guarantee audio and video are the same length. Without that the parts drift
 * against each other and every concatenated cut pushes the desync further.
 */
function audioChain(label: string, seconds: string): string {
  return `[${label}]aresample=async=1:first_pts=0,apad,atrim=duration=${seconds},asetpts=N/SR/TB[a]`;
}

/** Fixed-point seconds: ffmpeg cannot parse the exponent form of a small float. */
function formatSeconds(value: number): string {
  return value.toFixed(6);
}

/**
 * Trims one cut out of a source clip and re-encodes it to the single format
 * every other cut shares: 1080x1920, 30fps, stereo 44.1kHz AAC.
 *
 * Uniformity is the whole point — Task 3 joins the cuts with the concat
 * demuxer, which stream-copies and therefore only works when every part agrees
 * on codec, resolution, frame rate and audio parameters.
 */
export async function normaliseCut(input: {
  sourcePath: string;
  startSeconds: number;
  endSeconds: number;
  outputPath: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const duration = input.endSeconds - input.startSeconds;
  if (!Number.isFinite(duration) || duration <= 0) {
    return { success: false, error: `Cut has non-positive duration (${duration}s)` };
  }
  if (!Number.isFinite(input.startSeconds) || input.startSeconds < 0) {
    return { success: false, error: `Cut has an invalid start (${input.startSeconds}s)` };
  }

  // A source with no audio still has to yield an audio track, or concatenation
  // drops the cut's slot in the audio timeline and everything after it desyncs.
  // Probing first and picking one of two plain command shapes beats mixing the
  // real track with silence: `amix` needs both inputs to exist, and ffmpeg
  // rejects the whole filtergraph ("matches no streams") when they do not.
  let hasAudio: boolean;
  try {
    hasAudio = await probeHasAudio(input.sourcePath);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  const seconds = formatSeconds(duration);
  // -ss before -i seeks fast; putting it after -i would decode from zero every
  // time, which is slow on a 36s source cut near its end.
  const trimmedSource = [
    '-ss', formatSeconds(input.startSeconds),
    '-t', seconds,
    '-i', input.sourcePath,
  ];
  const silenceInput = hasAudio
    ? []
    : ['-f', 'lavfi', '-t', seconds, '-i', `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE}`];

  return runFfmpeg([
    ...trimmedSource,
    ...silenceInput,
    '-filter_complex',
    `[0:v:0]${REFRAME}[v];${audioChain(hasAudio ? '0:a:0' : '1:a:0', seconds)}`,
    '-map', '[v]',
    '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
    input.outputPath,
  ]);
}
