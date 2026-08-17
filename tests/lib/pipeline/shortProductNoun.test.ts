import { describe, it, expect } from 'vitest';
import { shortProductNoun } from '@/lib/pipeline/director';

describe('shortProductNoun', () => {
  it('takes the last real word as the item noun', () => {
    expect(shortProductNoun('streetwear zip-up hoodie')).toBe('hoodie');
    expect(shortProductNoun('gorpcore cargos')).toBe('cargos');
    expect(shortProductNoun('fitted henley')).toBe('henley');
  });

  it('skips a trailing model number or SKU rather than naming the hook after it', () => {
    // The bug: "Hoodie #1" made every hook say "#1".
    expect(shortProductNoun('Hoodie #1')).toBe('hoodie');
    expect(shortProductNoun('Hoodie v2')).toBe('hoodie');
    expect(shortProductNoun('Sweatpants (black)')).toBe('sweatpants');
  });

  it('falls back to the raw name when there is no plain word at all', () => {
    expect(shortProductNoun('#1')).toBe('#1');
  });
});
