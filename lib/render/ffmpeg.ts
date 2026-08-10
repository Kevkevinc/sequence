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

/** Upper bound on a stored error string; `renders.failure_reason` is unbounded text. */
const MAX_ERROR_CHARS = 1000;

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

/**
 * Keeps the *end* of an over-long string.
 *
 * ffmpeg puts its diagnosis last, after any amount of decoder chatter, and
 * Node's own failure message opens with the entire command line — a
 * 200-character `-filter_complex` argument included. Truncating from the front
 * would spend the whole budget echoing back the command we just built.
 */
function keepTail(text: string): string {
  if (text.length <= MAX_ERROR_CHARS) return text;
  return `...${text.slice(-(MAX_ERROR_CHARS - 3))}`;
}

/** Pulls the useful text out of a failed execFile, preferring the tool's own stderr. */
function describeProcessFailure(error: unknown, tool: string, timeoutMs: number): string {
  const details = (error ?? {}) as { stderr?: unknown; killed?: unknown; signal?: unknown };
  // ffmpeg reports the real problem on stderr; the thrown Error's message is
  // usually just the exit code, so prefer stderr when present.
  const stderr = details.stderr === undefined ? '' : String(details.stderr);
  const message = error instanceof Error ? error.message : String(error);
  const detail = keepTail(stderr.trim() || message);

  // A killed process wrote nothing to stderr, so the fallback is Node's
  // "Command failed: <the entire command line>" — which explains nothing at the
  // one moment somebody needs to know that a long render was cut off rather
  // than rejected. Say so explicitly.
  if (details.killed === true) {
    return `${tool} timed out after ${Math.round(timeoutMs / 1000)}s: ${detail}`;
  }
  // Killed by a signal with nothing on stderr is almost always the kernel's
  // OOM killer taking the process -- the single most useful thing to know when
  // a render fails on a memory-constrained host, and invisible without this.
  const signal = typeof details.signal === 'string' ? details.signal : '';
  if (signal && !stderr.trim()) {
    const oom = signal === 'SIGKILL' ? ' (likely out of memory)' : '';
    return `${tool} was killed by ${signal}${oom}: ${detail}`;
  }
  return detail;
}

/**
 * Runs ffmpeg with an argument array — never a shell string. Paths on Windows
 * contain colons, backslashes and spaces; passing an array means the OS hands
 * them to the process verbatim with no quoting rules in between.
 *
 * Never throws: a render failure is an outcome the caller records against the
 * job, not an exception to unwind through the worker.
 *
 * `timeoutMs` overrides the default ceiling for callers that know the work is
 * cheap and would rather fail fast than hang for ten minutes.
 */
export async function runFfmpeg(
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<{ success: true } | { success: false; error: string }> {
  const timeout = options.timeoutMs ?? FFMPEG_TIMEOUT_MS;
  try {
    await execFileAsync(ffmpegBinary(), ['-hide_banner', '-loglevel', 'warning', '-y', ...args], {
      timeout,
      maxBuffer: OUTPUT_BUFFER_BYTES,
      // Console applications spawned on Windows can flash a window; a worker
      // rendering twenty cuts should not strobe the desktop.
      windowsHide: true,
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: describeProcessFailure(error, 'ffmpeg', timeout) };
  }
}

export type AudioParameters = { codec: string; sampleRate: number; channels: number };

/** Everything one ffprobe call can tell us about a media file. */
export type MediaInfo = {
  /** Container duration: the longest stream, so never shorter than the picture. */
  containerDuration: number | null;
  video: {
    /** As displayed, with a quarter-turn rotation already applied. */
    width: number;
    height: number;
    /** Degrees the container asks a player to rotate by: 0, 90, 180 or 270. */
    rotation: number;
    duration: number | null;
  } | null;
  audio: (AudioParameters & { duration: number | null }) | null;
};

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

type ProbeResult = { streams?: ProbeStream[]; format?: { duration?: string } };

function toSeconds(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Rotation the container asks players to apply, normalised to 0/90/180/270. */
function rotationOf(stream: ProbeStream): number {
  const raw = stream.side_data_list?.find((entry) => typeof entry.rotation === 'number')?.rotation;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return ((Math.round(raw) % 360) + 360) % 360;
}

/**
 * Reads a file's stream metadata with ffprobe.
 *
 * One call answers every question asked here, so a caller needing several facts
 * about the same file costs one process spawn rather than one per question.
 *
 * Unlike {@link runFfmpeg} this throws on failure. A probe answers a question
 * ("how long is this?") rather than performing work, and there is no sensible
 * result to return when the file cannot be read — callers that need the
 * result-object contract are already inside one, so the throw surfaces there.
 */
export async function probeMedia(filePath: string): Promise<MediaInfo> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      ffprobeBinary(),
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: OUTPUT_BUFFER_BYTES, windowsHide: true }
    );
    stdout = result.stdout;
  } catch (error) {
    const detail = describeProcessFailure(error, 'ffprobe', FFPROBE_TIMEOUT_MS);
    throw new Error(`ffprobe failed for ${filePath}: ${detail}`);
  }

  let parsed: ProbeResult;
  try {
    parsed = JSON.parse(stdout) as ProbeResult;
  } catch {
    throw new Error(`ffprobe returned unparseable output for ${filePath}`);
  }

  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');

  // Phone footage is stored landscape with a rotation tag, so the stored width
  // and height are swapped relative to what the viewer sees. Reporting the
  // stored pair would make a portrait clip look like a landscape one to
  // anything reasoning about aspect ratio.
  const quarterTurn = video ? rotationOf(video) % 180 === 90 : false;

  return {
    containerDuration: toSeconds(parsed.format?.duration),
    video:
      video && video.width && video.height
        ? {
            width: quarterTurn ? video.height : video.width,
            height: quarterTurn ? video.width : video.height,
            rotation: rotationOf(video),
            duration: toSeconds(video.duration),
          }
        : null,
    audio: audio
      ? {
          codec: audio.codec_name ?? 'unknown',
          sampleRate: Number(audio.sample_rate) || 0,
          channels: audio.channels ?? 0,
          duration: toSeconds(audio.duration),
        }
      : null,
  };
}

/**
 * Length of the file in seconds.
 *
 * This is the container duration — the longest stream — so on a file whose
 * audio outlasts its video it exceeds the picture. Anything deciding how much
 * of a source is actually usable wants {@link probeMedia} and the video
 * stream's own duration instead.
 */
export async function probeDuration(filePath: string): Promise<number> {
  const info = await probeMedia(filePath);
  const duration = info.containerDuration ?? info.video?.duration ?? null;
  if (duration === null) throw new Error(`Could not read a duration from ${filePath}`);
  return duration;
}

/** Dimensions as a player would show them, rotation included. */
export async function probeDimensions(
  filePath: string
): Promise<{ width: number; height: number }> {
  const { video } = await probeMedia(filePath);
  if (!video) throw new Error(`Could not read video dimensions from ${filePath}`);
  return { width: video.width, height: video.height };
}

/** Rotation tagged on the video stream, in degrees (0 when untagged). */
export async function probeRotation(filePath: string): Promise<number> {
  return (await probeMedia(filePath)).video?.rotation ?? 0;
}

export async function probeHasAudio(filePath: string): Promise<boolean> {
  return (await probeMedia(filePath)).audio !== null;
}

/**
 * Audio codec, sample rate and channel count, or null when there is no audio.
 *
 * Concatenation with the concat demuxer stream-copies its parts, so every part
 * has to agree on all three.
 */
export async function probeAudioParameters(filePath: string): Promise<AudioParameters | null> {
  const { audio } = await probeMedia(filePath);
  if (!audio) return null;
  return { codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.channels };
}
