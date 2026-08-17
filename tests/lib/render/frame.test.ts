import { describe, it, expect } from 'vitest';
import { QUALITY_PROFILES, profileForQuality } from '@/lib/render/frame';

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
});
