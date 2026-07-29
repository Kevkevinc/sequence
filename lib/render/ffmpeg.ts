import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';
import { path as ffprobePath } from 'ffprobe-static';
import { getEnvWithDefault } from '@/lib/env';

const execFileAsync = promisify(execFile);

/** Longest any single ffmpeg invocation may run before being killed. */
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

/** ffprobe only reads headers, so it has no business taking longer than this. */
const FFPROBE_TIMEOUT_MS = 60 * 1000;

const OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Resolves a binary path, letting the environment override the bundled one.
 *
 * The bundled binaries are what makes this work with no install step, but a
 * deployment target may already carry its own build (a slimmer container image,
 * or one with hardware encoders), and swapping it should not need a code change.
 */
function resolveBinary(envName: string, bundled: string | null, label: string): string {
  const resolved = getEnvWithDefault(envName, bundled ?? '');
  if (!resolved) {
    throw new Error(`No ${label} binary available for this platform; set ${envName} to one`);
  }
  return resolved;
}

function ffmpegBinary(): string {
  return resolveBinary('FFMPEG_PATH', ffmpegPath, 'ffmpeg');
}

function ffprobeBinary(): string {
  return resolveBinary('FFPROBE_PATH', ffprobePath, 'ffprobe');
}

/** Pulls the useful text out of a failed execFile, preferring the tool's own stderr. */
function describeProcessFailure(error: unknown): string {
  // ffmpeg reports the real problem on stderr; the thrown Error's message is
  // usually just the exit code, so prefer stderr when present.
  const stderr =
    error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
  const message = error instanceof Error ? error.message : String(error);
  return (stderr.trim() || message).slice(0, 1000);
}

/**
 * Runs ffmpeg with an argument array — never a shell string. Paths on Windows
 * contain colons, backslashes and spaces; passing an array means the OS hands
 * them to the process verbatim with no quoting rules in between.
 *
 * Never throws: a render failure is an outcome the caller records against the
 * job, not an exception to unwind through the worker.
 */
export async function runFfmpeg(
  args: string[]
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    await execFileAsync(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: OUTPUT_BUFFER_BYTES,
      // Console applications spawned on Windows can flash a window; a worker
      // rendering twenty cuts should not strobe the desktop.
      windowsHide: true,
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: describeProcessFailure(error) };
  }
}

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  side_data_list?: Array<{ rotation?: number }>;
};

type ProbeResult = {
  streams?: ProbeStream[];
  format?: { duration?: string };
};

/**
 * Reads a file's stream metadata with ffprobe.
 *
 * Unlike {@link runFfmpeg} this throws on failure. A probe answers a question
 * ("how long is this?") rather than performing work, and there is no sensible
 * result to return when the file cannot be read — callers that need the
 * result-object contract are already inside one, so the throw surfaces there.
 */
async function probe(filePath: string): Promise<ProbeResult> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      ffprobeBinary(),
      [
        '-v', 'error',
        '-show_streams',
        '-show_format',
        '-of', 'json',
        filePath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: OUTPUT_BUFFER_BYTES, windowsHide: true }
    );
    stdout = result.stdout;
  } catch (error) {
    throw new Error(`ffprobe failed for ${filePath}: ${describeProcessFailure(error)}`);
  }

  try {
    return JSON.parse(stdout) as ProbeResult;
  } catch {
    throw new Error(`ffprobe returned unparseable output for ${filePath}`);
  }
}

function firstStream(result: ProbeResult, type: 'video' | 'audio'): ProbeStream | undefined {
  return result.streams?.find((stream) => stream.codec_type === type);
}

/** Rotation the container asks players to apply, normalised to 0/90/180/270. */
function rotationOf(stream: ProbeStream | undefined): number {
  const raw = stream?.side_data_list?.find((entry) => typeof entry.rotation === 'number')?.rotation;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return ((Math.round(raw) % 360) + 360) % 360;
}

/** Length of the file in seconds, as the container reports it. */
export async function probeDuration(filePath: string): Promise<number> {
  const result = await probe(filePath);
  // Prefer the container duration: it covers every stream, whereas a single
  // stream's duration can be absent or trail the file by a frame.
  const candidates = [result.format?.duration, firstStream(result, 'video')?.duration];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  throw new Error(`Could not read a duration from ${filePath}`);
}

/**
 * Dimensions as a player would show them.
 *
 * Phone footage is stored landscape with a rotation tag, so the stored width
 * and height are swapped relative to what the viewer sees. Returning the stored
 * pair would make a portrait clip look like a landscape one to anything
 * reasoning about aspect ratio.
 */
export async function probeDimensions(
  filePath: string
): Promise<{ width: number; height: number }> {
  const result = await probe(filePath);
  const video = firstStream(result, 'video');
  if (!video?.width || !video?.height) {
    throw new Error(`Could not read video dimensions from ${filePath}`);
  }

  const quarterTurn = rotationOf(video) % 180 === 90;
  return quarterTurn
    ? { width: video.height, height: video.width }
    : { width: video.width, height: video.height };
}

/** Rotation tagged on the video stream, in degrees (0 when untagged). */
export async function probeRotation(filePath: string): Promise<number> {
  return rotationOf(firstStream(await probe(filePath), 'video'));
}

export async function probeHasAudio(filePath: string): Promise<boolean> {
  return firstStream(await probe(filePath), 'audio') !== undefined;
}

/**
 * Audio codec, sample rate and channel count, or null when there is no audio.
 *
 * Concatenation with the concat demuxer stream-copies its parts, so every part
 * has to agree on all three.
 */
export async function probeAudioParameters(
  filePath: string
): Promise<{ codec: string; sampleRate: number; channels: number } | null> {
  const audio = firstStream(await probe(filePath), 'audio');
  if (!audio) return null;
  return {
    codec: audio.codec_name ?? 'unknown',
    sampleRate: Number(audio.sample_rate) || 0,
    channels: audio.channels ?? 0,
  };
}
