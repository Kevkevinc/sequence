/**
 * Video length is now a continuous range rather than four fixed buttons, so the
 * creator can match whatever a given shoot actually supports.
 */
export const MIN_LENGTH_SECONDS = 10;
export const MAX_LENGTH_SECONDS = 60;

/**
 * Raw footage (in seconds) a job should have to make its variations comfortably.
 *
 * The first variation needs roughly the full target length of usable footage;
 * each additional variation wants about half a length of *fresh* material, or
 * they end up drawn from the same moments and read as reshuffles of each other.
 * A heuristic, not a hard law -- footage reuse across variations is allowed --
 * but it catches the real failure ("41s of footage, 10 variations of 30s") the
 * moment the creator picks their settings, before they upload and wait.
 */
export function recommendedFootageSeconds(lengthSeconds: number, variationCount: number): number {
  return Math.round(lengthSeconds * (1 + 0.5 * Math.max(0, variationCount - 1)));
}
export const ALLOWED_PACINGS = ['slow', 'medium', 'fast'] as const;
export const MAX_VARIATION_COUNT = 20;

export type JobValidationError = { field: string; message: string };

export function validateJobInput(input: {
  productName: string;
  lengthSeconds: number;
  pacing?: string;
  styleId?: string;
  variationCount: number;
  sizingOverlayEnabled: boolean;
  sizeWorn?: string;
  clipCount: number;
}): JobValidationError[] {
  const errors: JobValidationError[] = [];

  // A non-string productName (e.g. a JSON body with `"productName": 123`) is
  // treated as missing rather than allowed to throw on `.trim()`.
  if (typeof input.productName !== 'string' || !input.productName.trim()) {
    errors.push({ field: 'productName', message: 'Product name is required.' });
  }
  // Whole seconds only: the slider steps in seconds, and a fractional target
  // would make the "within 10% of target" rule read strangely in the UI.
  if (
    typeof input.lengthSeconds !== 'number' ||
    !Number.isInteger(input.lengthSeconds) ||
    input.lengthSeconds < MIN_LENGTH_SECONDS ||
    input.lengthSeconds > MAX_LENGTH_SECONDS
  ) {
    errors.push({
      field: 'lengthSeconds',
      message: `Length must be a whole number between ${MIN_LENGTH_SECONDS} and ${MAX_LENGTH_SECONDS} seconds.`,
    });
  }

  const hasPacing = typeof input.pacing === 'string' && input.pacing.length > 0;
  const hasStyleId = typeof input.styleId === 'string' && input.styleId.length > 0;
  if (hasPacing === hasStyleId) {
    errors.push({
      field: 'mode',
      message: 'Choose either a pacing (Custom mode) or a style (Style mode), not both or neither.',
    });
  } else if (hasPacing && !ALLOWED_PACINGS.includes(input.pacing as (typeof ALLOWED_PACINGS)[number])) {
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
  // Same here: a non-string sizeWorn counts as missing, not as a crash.
  if (
    input.sizingOverlayEnabled &&
    (typeof input.sizeWorn !== 'string' || !input.sizeWorn.trim())
  ) {
    errors.push({ field: 'sizeWorn', message: 'Size worn is required when sizing info is enabled.' });
  }
  if (input.clipCount < 1) {
    errors.push({ field: 'clips', message: 'At least one raw clip is required.' });
  }

  return errors;
}
