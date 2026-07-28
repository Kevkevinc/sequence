export const ALLOWED_LENGTHS = [15, 30, 45, 60] as const;
export const ALLOWED_PACINGS = ['slow', 'medium', 'fast'] as const;
export const MAX_VARIATION_COUNT = 20;

export type JobValidationError = { field: string; message: string };

export function validateJobInput(input: {
  productName: string;
  lengthSeconds: number;
  pacing: string;
  variationCount: number;
  sizingOverlayEnabled: boolean;
  sizeWorn?: string;
  clipCount: number;
}): JobValidationError[] {
  const errors: JobValidationError[] = [];

  if (!input.productName.trim()) {
    errors.push({ field: 'productName', message: 'Product name is required.' });
  }
  if (!ALLOWED_LENGTHS.includes(input.lengthSeconds as (typeof ALLOWED_LENGTHS)[number])) {
    errors.push({ field: 'lengthSeconds', message: 'Length must be 15, 30, 45, or 60 seconds.' });
  }
  if (!ALLOWED_PACINGS.includes(input.pacing as (typeof ALLOWED_PACINGS)[number])) {
    errors.push({ field: 'pacing', message: 'Pacing must be slow, medium, or fast.' });
  }
  if (
    typeof input.variationCount !== 'number' ||
    Number.isNaN(input.variationCount) ||
    input.variationCount < 1 ||
    input.variationCount > MAX_VARIATION_COUNT
  ) {
    errors.push({
      field: 'variationCount',
      message: `Variation count must be between 1 and ${MAX_VARIATION_COUNT}.`,
    });
  }
  if (input.sizingOverlayEnabled && !input.sizeWorn?.trim()) {
    errors.push({ field: 'sizeWorn', message: 'Size worn is required when sizing info is enabled.' });
  }
  if (input.clipCount < 1) {
    errors.push({ field: 'clips', message: 'At least one raw clip is required.' });
  }

  return errors;
}
