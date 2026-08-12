import { rm } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';
import { probeMedia, type MediaInfo, runFfmpeg } from '@/lib/render/ffmpeg';

import { FPS, HEIGHT, WIDTH } from '@/lib/render/frame';

const execFileAsync = promisify(execFile);

/**
 * Crop-to-fill rather than letterbox: black bars read as amateur in short-form
 * UGC, and the footage is shot vertically anyway. `increase` scales until both
 * dimensions cover the frame, then the crop takes the centre.
 *
 * Rotation needs no filter here. ffmpeg autorotates on decode, so a phone clip
 * stored landscape with a 90-degree display matrix reaches this chain already
 * upright, and the re-encode drops the tag so nothing rotates it twice.
 */
/**
 * Mild unsharp mask, applied immediately after the downscale.
 *
 * Shrinking 4K phone footage to 1080p necessarily softens it — four pixels of
 * fabric weave average into one — and that softness is most of what a tester
 * meant by the output looking worse than his own edits. Sharpening after the
 * scale puts the apparent detail back.
 *
 * 0.8 is deliberately restrained. It was chosen against a stack of strengths
 * on textured fabric: at 1.4 the same clip stops reading as detailed and
 * starts reading as gritty, because an unsharp mask amplifies sensor noise
 * along with real texture — which would re-create the exact "staticy"
 * complaint this is meant to fix. Luma only (the trailing `0.0`); sharpening
 * chroma on 4:2:0 footage buys nothing and invites colour fringing.
 */
const DOWNSCALE_SHARPEN = 'unsharp=5:5:0.8:5:5:0.0';

const REFRAME =
  `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,` +
  `crop=${WIDTH}:${HEIGHT},${DOWNSCALE_SHARPEN},setsar=1,fps=${FPS}`;

/**
 * Quality of the per-cut intermediate.
 *
 * These parts are re-encoded once more when the hook text is burned in, so
 * whatever they lose is baked into the delivered video. Near-transparent here
 * (source phone footage is 25-40Mbps) keeps the second pass from compounding
 * a first-generation loss. The files are large but live only for the length of
 * one render, inside a temp directory that is deleted either way.
 *
 * `superfast` rather than `veryfast`: this pass is throwaway — its only real
 * job is to make every cut agree on codec, size and frame rate so
 * {@link concatCuts} can stream-copy them — so encoder effort here buys
 * nothing the final pass keeps, and the faster preset costs only disk.
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

/**
 * Audio parameters every cut is forced to, so the parts can be stream-copied
 * together. Concatenation by copy needs identical codec, rate and layout —
 * exactly the same precondition the video side already satisfies.
 */
const AUDIO_RATE = 48_000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = '192k';

/**
 * Cleans up the recording before it is cut.
 *
 * Creators film wherever they are, which for talking-head footage is usually
 * outdoors or in a room with something humming. On a real tester's take —
 * filmed on a patio beside a road — the gap between his voice and the
 * background measured 19dB; after this chain it measures 31dB, with his own
 * level moving by barely one.
 *
 * `highpass` at 85Hz removes the low rumble that carries most of the outdoor
 * noise — wind, traffic, handling — and sits below a male speaking voice, whose
 * fundamental starts around 100Hz. Cutting higher would sound cleaner on a
 * meter and thinner in the ear, which is the wrong trade for somebody talking
 * to camera.
 *
 * `afftdn` then pulls down the broadband floor. `nf=-25` is deliberately short
 * of what the filter allows: pushed harder it starts eating the quiet tails of
 * words and leaving the scattered artefacts that make denoised audio sound
 * underwater. Verified on a spectrogram rather than by numbers alone — the
 * background between words drops away while the voice's harmonics stay intact.
 *
 * `tn=0` disables noise tracking so the filter behaves identically on every
 * cut. With tracking on, each cut would adapt to its own few seconds and the
 * background would shift audibly at every splice.
 */
const AUDIO_CLEANUP = 'highpass=f=85,afftdn=nf=-25:tn=0';

/**
 * How far under the louder channel a channel counts as carrying nothing.
 *
 * 40dB is not "quiet", it is off. A tester's phone wrote a stereo file with the
 * left channel at -26dB and the right at -116dB — a 90dB gap. Real stereo from
 * a phone held at arm's length is a couple of decibels apart at most, because
 * both microphones are pointed at the same person from the same place.
 */
const DEAD_CHANNEL_DB = 40;

export type ChannelBalance = 'stereo' | 'left-only' | 'right-only';

/**
 * Which channels of a recording actually contain anything.
 *
 * Phones record "stereo" whether or not they captured any, and some write a
 * second channel of pure digital silence. Copied through faithfully, that plays
 * out of one earbud — which is what happened, and which nobody notices until
 * they happen to be wearing headphones.
 */
export async function measureChannelBalance(mediaPath: string): Promise<ChannelBalance> {
  const binary = ffmpegPath;
  if (!binary) throw new Error('ffmpeg binary not found');

  let output = '';
  try {
    const result = await execFileAsync(binary, [
      '-hide_banner', '-nostats', '-i', mediaPath,
      '-map', '0:a:0', '-af', 'astats=metadata=0:reset=0', '-f', 'null', '-',
    ], { maxBuffer: 64 * 1024 * 1024 });
    output = `${result.stdout}
${result.stderr}`;
  } catch (error) {
    const withOutput = error as { stdout?: string; stderr?: string };
    output = `${withOutput.stdout ?? ''}
${withOutput.stderr ?? ''}`;
  }

  // astats prints a block per channel and then an Overall block; only the
  // per-channel ones are wanted, and they are the ones that come first.
  const levels: number[] = [];
  for (const match of output.matchAll(/Channel:\s*\d+[\s\S]*?RMS level dB:\s*(-?[\d.]+|-?inf|nan)/g)) {
    const value = Number(match[1]);
    levels.push(Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY);
  }

  // Anything that is not a two-channel reading is left alone: mono is already
  // centred, and a genuine multichannel mix is not ours to second-guess.
  if (levels.length !== 2) return 'stereo';
  if (levels[0] - levels[1] > DEAD_CHANNEL_DB) return 'left-only';
  if (levels[1] - levels[0] > DEAD_CHANNEL_DB) return 'right-only';
  return 'stereo';
}

/**
 * Puts the voice in both ears.
 *
 * A dead channel is rebuilt from the live one at full level rather than by
 * averaging the pair, which would halve the volume of a recording whose only
 * fault is that half of it was never written.
 *
 * A recording with two live channels is folded to the centre rather than
 * averaged-and-kept, because these are single voices talking to a phone. There
 * is no stereo image in that to protect, and half the audience is listening on
 * one earbud or a phone speaker where a hard-panned anything is a defect.
 */
function centreChannels(balance: ChannelBalance): string {
  if (balance === 'left-only') return 'pan=stereo|c0=c0|c1=c0,';
  if (balance === 'right-only') return 'pan=stereo|c0=c1|c1=c1,';
  return 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1,';
}

/**
 * Trims the audio alongside the picture, keeping the two in step.
 *
 * `asetpts=N/SR/TB` restarts the timestamps at zero the way the video chain
 * does, and `aresample=async=1` fills or drops samples to hold the audio
 * against those timestamps rather than letting it slide. Without it a cut taken
 * from the middle of a long recording can start a few tens of milliseconds out,
 * and on a talking-head video that reads immediately as bad lip sync — the one
 * defect this mode cannot ship with.
 */
function audioChain(seconds: string, cleanUp: boolean, balance: ChannelBalance): string {
  return (
    `[0:a:0]atrim=duration=${seconds},asetpts=N/SR/TB,` +
    // Before the cleanup, so the denoiser sees the same signal in both channels
    // and cannot leave them treated differently.
    centreChannels(balance) +
    (cleanUp ? `${AUDIO_CLEANUP},` : '') +
    `aresample=${AUDIO_RATE}:async=1:first_pts=0,` +
    `aformat=sample_fmts=fltp:channel_layouts=stereo[a]`
  );
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
 * every other cut shares: 1080x1920, 30fps.
 *
 * Audio is dropped unless `keepAudio` asks for it. The silent modes re-sequence
 * cuts freely, which would chop a clip's own audio into disjointed snippets, so
 * carrying it would produce something worse than silence. Talking-head mode is
 * the opposite: its cuts are chosen *from* the audio and must keep it, in sync,
 * which is why this is a per-call decision rather than a property of the file.
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
  /** Keep the source audio, trimmed in step with the picture. Talking-head mode. */
  keepAudio?: boolean;
  /**
   * Reduce background noise in that audio. On by default when audio is kept —
   * see {@link AUDIO_CLEANUP} — and separable so a creator with a clean studio
   * recording can be given the raw take if that ever proves better.
   */
  cleanUpAudio?: boolean;
  /**
   * Which channels the source actually uses, from {@link measureChannelBalance}.
   *
   * Passed in rather than measured here because this runs once per cut, and a
   * per-cut measurement could classify two cuts of one recording differently —
   * the same trap as noise tracking, and just as audible at the splice.
   */
  channelBalance?: ChannelBalance;
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
  /*
   * Talking-head cuts keep their audio; every other mode strips it.
   *
   * Requested rather than inferred from the source, because "this clip happens
   * to have an audio track" is not the same question as "this edit is built
   * around what is being said". Product footage routinely carries room noise
   * nobody wants under a voiceover.
   */
  const keepAudio = input.keepAudio === true && media.audio !== null;
  if (input.keepAudio === true && media.audio === null) {
    return {
      success: false,
      error: `This cut needs audio but ${input.sourcePath} has no audio track`,
    };
  }

  const result = await runFfmpeg([
    '-xerror',
    '-ss', formatSeconds(start), '-t', seconds, '-i', input.sourcePath,
    '-filter_complex', keepAudio
      ? `${videoChain(seconds)};${audioChain(seconds, input.cleanUpAudio !== false, input.channelBalance ?? 'stereo')}`
      : videoChain(seconds),
    '-map', '[v]',
    ...(keepAudio
      ? ['-map', '[a]', '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ar', String(AUDIO_RATE), '-ac', String(AUDIO_CHANNELS)]
      : ['-an']),
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', INTERMEDIATE_CRF,
    '-pix_fmt', 'yuv420p',
    // Carried explicitly so the cut is tagged the same way the source was
    // (measured: every tester clip is tv-range BT.709). Untagged parts would
    // leave the final encode to guess, and a guess that lands on full range
    // washes the picture out.
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-color_range', 'tv',
    input.outputPath,
  ]);

  if (!result.success) await discardOutput(input.outputPath);
  return result;
}
