import { describe, it, expect } from 'vitest';
import {
  MAX_VARIATION_COUNT,
  maxVariationsForFootage,
  recommendedFootageSeconds,
} from '@/lib/validation/job';

describe('maxVariationsForFootage', () => {
  it('is the inverse of recommendedFootageSeconds', () => {
    // The two numbers are shown to the creator side by side, so they must never
    // disagree about what "enough footage" means.
    for (const length of [15, 30, 45, 60]) {
      for (const variations of [1, 2, 5, 10]) {
        const needed = recommendedFootageSeconds(length, variations);
        expect(maxVariationsForFootage(needed, length)).toBeGreaterThanOrEqual(variations);
      }
    }
  });

  it('reports the real case that failed a live job', () => {
    // ~40s of footage, ten 30s videos ordered. The creator waited four minutes
    // for a Zod rule name; the honest answer is that this supports one.
    expect(maxVariationsForFootage(40, 30)).toBe(1);
    expect(recommendedFootageSeconds(30, 10)).toBe(165);
  });

  it('grows as footage grows', () => {
    expect(maxVariationsForFootage(30, 30)).toBe(1);
    expect(maxVariationsForFootage(45, 30)).toBe(2);
    expect(maxVariationsForFootage(60, 30)).toBe(3);
    expect(maxVariationsForFootage(165, 30)).toBe(10);
  });

  it('never advises zero, and never exceeds the allowed maximum', () => {
    // Zero would be a dead end rather than advice, and advising more than the
    // form accepts would be advice the creator cannot follow.
    expect(maxVariationsForFootage(0, 30)).toBe(1);
    expect(maxVariationsForFootage(1, 30)).toBe(1);
    expect(maxVariationsForFootage(100_000, 30)).toBe(MAX_VARIATION_COUNT);
  });

  it('does not divide by zero on a nonsense length', () => {
    expect(maxVariationsForFootage(60, 0)).toBe(1);
  });
});
