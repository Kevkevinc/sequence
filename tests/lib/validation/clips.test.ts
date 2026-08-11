import { describe, it, expect } from 'vitest';
import { MIN_CLIP_SECONDS, checkClipDurations } from '@/lib/validation/job';

describe('checkClipDurations', () => {
  it('separates clips too short to cut from the rest', () => {
    // The real upload that failed: six clips of 1-2s and one long one.
    const { usable, tooShortIndexes } = checkClipDurations([29, 1, 1, 2, 2.1, 2, 1]);
    expect(usable).toEqual([29]);
    expect(tooShortIndexes).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps a clip exactly on the limit', () => {
    expect(checkClipDurations([MIN_CLIP_SECONDS]).tooShortIndexes).toEqual([]);
  });

  it('keeps clips it could not measure rather than rejecting them', () => {
    // Refusing an upload because the browser failed to read its duration would
    // block a good clip on our own limitation.
    expect(checkClipDurations([0, 10]).tooShortIndexes).toEqual([]);
    expect(checkClipDurations([0, 10]).usable).toEqual([0, 10]);
  });

  it('handles an empty selection', () => {
    expect(checkClipDurations([])).toEqual({ usable: [], tooShortIndexes: [] });
  });
});
