import { escapeFilterPath } from '@/lib/render/captions';
import { DEFAULT_PROFILE, deliveryBitrateArgs, type QualityProfile } from '@/lib/render/frame';
import {
  AUDIO_BITRATE,
  AUDIO_CHANNELS,
  AUDIO_CLEANUP,
  AUDIO_RATE,
  reframeFor,
  centreChannels,
  snapToFrame,
  type ChannelBalance,
} from '@/lib/render/normalise';

/**
 * Builds the one ffmpeg command that renders a whole talking-head edit.
 *
 * The old path encoded every speech run to its own intermediate file, stream-
 * copied them together, then re-encoded the join a second time to burn the
 * captions on. That second encode is a second generation of lossy compression
 * on top of the first — and on downscaled phone footage, which is almost
 * entirely fine high-frequency detail, a compressor spends that detail first.
 * Doing everything in one filter graph means the picture is compressed exactly
 * once, the same number of times a creator's own hand-edit is before TikTok
 * sees it.
 *
 * The graph, per run, mirrors the chains {@link normaliseCut} already proved
 * out — reframe the picture, centre and clean the sound — then joins the runs
 * with the concat *filter* (not the demuxer, which cannot exist inside a single
 * pass) and lays the captions over the joined result.
 *
 * Pure: it returns the argument array and reads nothing from disk, so the whole
 * graph is assertable in a unit test without ffmpeg or a real recording.
 */
export function buildTalkingHeadArgs(input: {
  sourcePath: string;
  runs: { startSeconds: number; endSeconds: number }[];
  assPath: string;
  fontsDir: string;
  outputPath: string;
  channelBalance: ChannelBalance;
  /** Reduce background noise. On by default; see {@link AUDIO_CLEANUP}. */
  cleanUpAudio?: boolean;
  /** Output resolution and CRF. Defaults to 1080p. */
  profile?: QualityProfile;
}): string[] {
  const cleanUp = input.cleanUpAudio !== false;
  const profile = input.profile ?? DEFAULT_PROFILE;
  const pan = centreChannels(input.channelBalance);
  const reframe = reframeFor(profile);

  const segments: string[] = [];
  const concatInputs: string[] = [];

  input.runs.forEach((run, index) => {
    // Snap to whole frames so each segment is an exact frame count; a segment
    // that ended mid-frame would leave the concat filter aligning audio against
    // a picture that is fractionally the wrong length.
    const start = snapToFrame(run.startSeconds);
    const duration = snapToFrame(run.endSeconds - run.startSeconds);
    const startArg = start.toFixed(6);
    const durationArg = duration.toFixed(6);

    // Trim first, then reframe only the frames that survive. `setpts` renumbers
    // the kept frames from zero so the concat filter can butt them together.
    segments.push(
      `[0:v]trim=start=${startArg}:duration=${durationArg},${reframe},` +
        `setpts=N/FRAME_RATE/TB[v${index}]`
    );
    segments.push(
      `[0:a]atrim=start=${startArg}:duration=${durationArg},asetpts=N/SR/TB,` +
        // Centre the channels before any cleanup, so the denoiser sees the same
        // signal in both and cannot leave them treated differently.
        pan +
        (cleanUp ? `${AUDIO_CLEANUP},` : '') +
        `aresample=${AUDIO_RATE}:async=1:first_pts=0,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`
    );
    concatInputs.push(`[v${index}][a${index}]`);
  });

  const n = input.runs.length;
  const concat = `${concatInputs.join('')}concat=n=${n}:v=1:a=1[vc][ac]`;
  // Captions are timed against the edited timeline, and the concat above
  // produces exactly that timeline, so they burn onto the joined picture.
  const captions =
    `[vc]subtitles='${escapeFilterPath(input.assPath)}':` +
    `fontsdir='${escapeFilterPath(input.fontsDir)}'[v]`;

  const filterComplex = [...segments, concat, captions].join(';');

  // The edit is exactly the kept runs joined, so its length is their snapped
  // durations summed — which sizes the 4K download-bitrate cap so the delivered
  // file stays small enough for the phone to save. See {@link deliveryBitrateArgs}.
  const deliverySeconds = input.runs.reduce(
    (total, run) => total + snapToFrame(run.endSeconds - run.startSeconds),
    0
  );

  return [
    '-i', input.sourcePath,
    '-filter_complex', filterComplex,
    '-map', '[v]', '-map', '[ac]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', profile.finalCrf,
    ...profile.encodeArgs,
    ...deliveryBitrateArgs(profile, deliverySeconds),
    '-pix_fmt', 'yuv420p',
    // Tag the picture as what every tester clip measured — tv-range BT.709 —
    // rather than leaving an upload pipeline to guess and shift the colour.
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ar', String(AUDIO_RATE), '-ac', String(AUDIO_CHANNELS),
    '-movflags', '+faststart',
    input.outputPath,
  ];
}
