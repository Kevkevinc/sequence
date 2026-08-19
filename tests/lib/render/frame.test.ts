import { describe, it, expect } from 'vitest';
import {
  DELIVERY_MAX_MBPS,
  deliveryBitrateArgs,
  QUALITY_PROFILES,
  profileForQuality,
} from '@/lib/render/frame';
import { MAX_LENGTH_SECONDS, MIN_LENGTH_SECONDS } from '@/lib/validation/job';

/** Pulls the numeric Mbps out of a `deliveryBitrateArgs` result, or null. */
function maxrateMbps(args: string[]): number | null {
  const i = args.indexOf('-maxrate');
  if (i < 0) return null;
  return Number(args[i + 1].replace(/M$/i, ''));
}

describe('quality profiles', () => {
  it('maps a stored quality to its profile, defaulting to 1080p', () => {
    expect(profileForQuality('4k').quality).toBe('4k');
    expect(profileForQuality('1080p').quality).toBe('1080p');
    // Anything unexpected (null, an old row, a bad value) is 1080p, never a throw.
    expect(profileForQuality(undefined).quality).toBe('1080p');
    expect(profileForQuality('720p').quality).toBe('1080p');
  });

  it('scales a reference-width metric by the frame: identity at 1080p, double at 4K', () => {
    // This identity is why the 1080p profile reproduces the old constants and
    // why 4K's captions/overlays come out the right size — every metric is
    // authored at 1080 and scaled through here.
    expect(QUALITY_PROFILES['1080p'].scaled(36)).toBe(36);
    expect(QUALITY_PROFILES['4k'].scaled(36)).toBe(72);
  });

  it('renders 4K at native portrait 4K', () => {
    expect(QUALITY_PROFILES['4k'].width).toBe(2160);
    expect(QUALITY_PROFILES['4k'].height).toBe(3840);
  });

  it('caps a full-length 4K clip small enough for the phone share sheet', () => {
    // Uncapped, 4K rode ~114 Mbps: a 60s clip was ~860MB. The app fetches the
    // whole video into memory to hand it to the iOS share sheet, and a file that
    // size buffers past WebKit's per-tab ceiling and crashes the download ("a
    // problem repeatedly occurred"). The delivery cap must keep even the longest
    // clip a creator can ask for under the share sheet's practical limit.
    const args = deliveryBitrateArgs(QUALITY_PROFILES['4k'], MAX_LENGTH_SECONDS);
    const mbps = maxrateMbps(args);
    expect(mbps).not.toBeNull();
    const worstCaseBytes = (mbps! * 1_000_000 * MAX_LENGTH_SECONDS) / 8;
    expect(worstCaseBytes).toBeLessThan(160 * 1024 * 1024);
    // maxrate is meaningless to libx264 without a bufsize to size its VBV window.
    expect(args).toContain('-bufsize');
  });

  it('spends the full 4K bitrate on a typical short clip, throttling only long ones', () => {
    // The point of sizing per clip rather than a flat cap: the common short clip
    // pays no quality tax, and only a clip long enough to threaten the file-size
    // limit is throttled.
    expect(maxrateMbps(deliveryBitrateArgs(QUALITY_PROFILES['4k'], MIN_LENGTH_SECONDS))).toBe(
      DELIVERY_MAX_MBPS
    );
    expect(maxrateMbps(deliveryBitrateArgs(QUALITY_PROFILES['4k'], 30))).toBe(DELIVERY_MAX_MBPS);
    // A 60s clip cannot hold the target size at the full rate, so it is throttled.
    expect(maxrateMbps(deliveryBitrateArgs(QUALITY_PROFILES['4k'], 60))!).toBeLessThan(
      DELIVERY_MAX_MBPS
    );
  });

  it('leaves 1080p uncapped — its files are already small enough to share', () => {
    // A 1080p clip is a quarter the pixels and never threatened the share sheet,
    // so it keeps CRF's own sizing rather than a bitrate ceiling that would only
    // cost it quality.
    expect(deliveryBitrateArgs(QUALITY_PROFILES['1080p'], 30)).toEqual([]);
  });

  it('adds no cap when the clip length is unknown', () => {
    // Older callers that pass nothing get no cap — larger 4K files, but never a
    // malformed bitrate from a zero or missing duration.
    expect(deliveryBitrateArgs(QUALITY_PROFILES['4k'], 0)).toEqual([]);
  });
});
