import { describe, it, expect } from 'vitest';
import { buildTalkingHeadArgs } from '@/lib/render/talkingHeadArgs';
import { QUALITY_PROFILES } from '@/lib/render/frame';

/** The filter graph string that follows the `-filter_complex` flag. */
function graphOf(args: string[]): string {
  const index = args.indexOf('-filter_complex');
  return index >= 0 ? args[index + 1] : '';
}

/** The value passed to the (single) `-crf` flag. */
function crfOf(args: string[]): string {
  return args[args.indexOf('-crf') + 1];
}

const base = {
  sourcePath: '/src.mp4',
  assPath: '/caps.ass',
  fontsDir: '/fonts',
  outputPath: '/out.mp4',
  channelBalance: 'stereo' as const,
};

describe('buildTalkingHeadArgs', () => {
  it('joins every cut and burns the captions in a single encode, not two passes', () => {
    const args = buildTalkingHeadArgs({
      ...base,
      runs: [
        { startSeconds: 0, endSeconds: 2 },
        { startSeconds: 5, endSeconds: 7 },
      ],
    });

    // The whole point of the change: one and only one lossy video encode in the
    // entire command. Two cuts used to mean two intermediate encodes plus a
    // final caption pass.
    expect(args.filter((arg) => arg === 'libx264')).toHaveLength(1);

    const graph = graphOf(args);
    // Both cuts are joined inside that single pass...
    expect(graph).toContain('concat=n=2:v=1:a=1');
    // ...and the captions ride along in the same pass rather than a second one.
    expect(graph).toContain('subtitles=');
    expect(args[args.length - 1]).toBe('/out.mp4');
  });

  it('trims picture and sound to the same window per cut, so lip sync holds', () => {
    const args = buildTalkingHeadArgs({
      ...base,
      runs: [{ startSeconds: 1, endSeconds: 3 }],
    });
    const graph = graphOf(args);
    expect(graph).toContain('trim=start=1');
    expect(graph).toContain('atrim=start=1');
  });

  it('rebuilds a dead channel from the live one', () => {
    const args = buildTalkingHeadArgs({
      ...base,
      channelBalance: 'left-only',
      runs: [{ startSeconds: 0, endSeconds: 2 }],
    });
    expect(graphOf(args)).toContain('pan=stereo|c0=c0|c1=c0');
  });

  it('renders the default (1080p) frame and CRF unchanged', () => {
    const args = buildTalkingHeadArgs({
      ...base,
      runs: [{ startSeconds: 0, endSeconds: 2 }],
    });
    // The 1080p path must be exactly what it was before quality was an option.
    expect(graphOf(args)).toContain('scale=1080:1920');
    expect(graphOf(args)).toContain('crop=1080:1920');
    expect(crfOf(args)).toBe('13');
  });

  it('renders at native 4K with the 4K CRF when the 4K profile is passed', () => {
    const args = buildTalkingHeadArgs({
      ...base,
      runs: [{ startSeconds: 0, endSeconds: 2 }],
      profile: QUALITY_PROFILES['4k'],
    });
    expect(graphOf(args)).toContain('scale=2160:3840');
    expect(graphOf(args)).toContain('crop=2160:3840');
    expect(crfOf(args)).toBe('14');
  });

  it('cleans background noise by default but leaves it when asked', () => {
    const withCleanup = buildTalkingHeadArgs({
      ...base,
      runs: [{ startSeconds: 0, endSeconds: 2 }],
    });
    expect(graphOf(withCleanup)).toContain('afftdn');

    const without = buildTalkingHeadArgs({
      ...base,
      cleanUpAudio: false,
      runs: [{ startSeconds: 0, endSeconds: 2 }],
    });
    expect(graphOf(without)).not.toContain('afftdn');
  });
});
