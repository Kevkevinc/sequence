import { describe, it, expect } from 'vitest';
import { validateJobInput } from '@/lib/validation/job';

const validInput = {
  productName: 'Blue Ribbed Tank Top',
  lengthSeconds: 30,
  pacing: 'medium',
  variationCount: 5,
  sizingOverlayEnabled: false,
  sizeWorn: undefined as string | undefined,
  clipCount: 4,
};

describe('validateJobInput', () => {
  it('returns no errors for valid input', () => {
    expect(validateJobInput(validInput)).toEqual([]);
  });

  it('requires a product name', () => {
    const errors = validateJobInput({ ...validInput, productName: '  ' });
    expect(errors).toContainEqual({ field: 'productName', message: 'Product name is required.' });
  });

  it('rejects a length outside the allowed presets', () => {
    const errors = validateJobInput({ ...validInput, lengthSeconds: 25 });
    expect(errors).toContainEqual({
      field: 'lengthSeconds',
      message: 'Length must be 15, 30, 45, or 60 seconds.',
    });
  });

  it('requires sizeWorn when the sizing overlay is enabled', () => {
    const errors = validateJobInput({ ...validInput, sizingOverlayEnabled: true, sizeWorn: '' });
    expect(errors).toContainEqual({
      field: 'sizeWorn',
      message: 'Size worn is required when sizing info is enabled.',
    });
  });

  it('does not require sizeWorn when the sizing overlay is disabled', () => {
    const errors = validateJobInput({ ...validInput, sizingOverlayEnabled: false, sizeWorn: undefined });
    expect(errors).toEqual([]);
  });

  it('requires at least one clip', () => {
    const errors = validateJobInput({ ...validInput, clipCount: 0 });
    expect(errors).toContainEqual({ field: 'clips', message: 'At least one raw clip is required.' });
  });

  it('rejects an invalid pacing value', () => {
    const errors = validateJobInput({ ...validInput, pacing: 'blazing' });
    expect(errors).toContainEqual({
      field: 'pacing',
      message: 'Pacing must be slow, medium, or fast.',
    });
  });

  it('rejects a variation count below the minimum', () => {
    const errors = validateJobInput({ ...validInput, variationCount: 0 });
    expect(errors).toContainEqual({
      field: 'variationCount',
      message: 'Variation count must be between 1 and 20.',
    });
  });

  it('rejects a variation count above the maximum', () => {
    const errors = validateJobInput({ ...validInput, variationCount: 21 });
    expect(errors).toContainEqual({
      field: 'variationCount',
      message: 'Variation count must be between 1 and 20.',
    });
  });

  it('treats a non-string product name as missing instead of throwing', () => {
    const errors = validateJobInput({
      ...validInput,
      productName: 123 as unknown as string,
    });
    expect(errors).toContainEqual({ field: 'productName', message: 'Product name is required.' });
  });

  it('treats a non-string sizeWorn as missing instead of throwing', () => {
    const errors = validateJobInput({
      ...validInput,
      sizingOverlayEnabled: true,
      sizeWorn: 42 as unknown as string,
    });
    expect(errors).toContainEqual({
      field: 'sizeWorn',
      message: 'Size worn is required when sizing info is enabled.',
    });
  });

  it('rejects a missing/undefined variation count instead of silently passing', () => {
    const errors = validateJobInput({
      ...validInput,
      variationCount: undefined as unknown as number,
    });
    expect(errors).toContainEqual({
      field: 'variationCount',
      message: 'Variation count must be between 1 and 20.',
    });
  });

  it('accepts a styleId in place of pacing', () => {
    const { pacing, ...withoutPacing } = validInput;
    const errors = validateJobInput({ ...withoutPacing, styleId: '11111111-1111-1111-1111-111111111111' });
    expect(errors).toEqual([]);
  });

  it('rejects providing both pacing and a styleId', () => {
    const errors = validateJobInput({ ...validInput, styleId: '11111111-1111-1111-1111-111111111111' });
    expect(errors).toContainEqual({
      field: 'mode',
      message: 'Choose either a pacing (Custom mode) or a style (Style mode), not both or neither.',
    });
  });

  it('rejects providing neither pacing nor a styleId', () => {
    const { pacing, ...withoutPacing } = validInput;
    const errors = validateJobInput({ ...withoutPacing });
    expect(errors).toContainEqual({
      field: 'mode',
      message: 'Choose either a pacing (Custom mode) or a style (Style mode), not both or neither.',
    });
  });
});
