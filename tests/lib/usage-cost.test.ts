import { describe, it, expect, afterEach } from 'vitest';
import { costOf } from '@/lib/pipeline/usage';

describe('costOf', () => {
  const originalInput = process.env.GEMINI_INPUT_COST_PER_MTOK;
  const originalOutput = process.env.GEMINI_OUTPUT_COST_PER_MTOK;

  afterEach(() => {
    for (const [key, value] of [
      ['GEMINI_INPUT_COST_PER_MTOK', originalInput],
      ['GEMINI_OUTPUT_COST_PER_MTOK', originalOutput],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('prices input and output separately, per million tokens', () => {
    process.env.GEMINI_INPUT_COST_PER_MTOK = '1';
    process.env.GEMINI_OUTPUT_COST_PER_MTOK = '10';

    // Output is the expensive side by an order of magnitude, so a single blended
    // rate would misreport which pipeline step is actually costing money.
    expect(costOf(1_000_000, 0)).toBeCloseTo(1, 6);
    expect(costOf(0, 1_000_000)).toBeCloseTo(10, 6);
    expect(costOf(500_000, 100_000)).toBeCloseTo(0.5 + 1, 6);
  });

  it('is zero for a call that reported no tokens', () => {
    expect(costOf(0, 0)).toBe(0);
  });

  it('falls back to built-in rates when the override is not a number', () => {
    // A typo'd rate must not silently price everything at zero, which would
    // read on the dashboard as "the API is free".
    process.env.GEMINI_INPUT_COST_PER_MTOK = 'not-a-number';
    process.env.GEMINI_OUTPUT_COST_PER_MTOK = 'also-not';
    expect(costOf(1_000_000, 1_000_000)).toBeGreaterThan(0);
  });
});
