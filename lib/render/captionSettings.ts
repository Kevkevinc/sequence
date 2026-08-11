import { z } from 'zod';
import { CAPTION_FONT_IDS, DEFAULT_CAPTION_FONT, type CaptionFontId } from '@/lib/render/fonts';

/**
 * How the burned-in text looks and where it sits.
 *
 * Positions are fractions of the frame (0-1) locating the *centre* of each
 * text block, not pixels. Two reasons: the frame size is a single constant
 * that has already changed once this project (see lib/render/frame.ts), and
 * the preview runs at a few hundred pixels wide while the render runs at 1080
 * — a pixel would mean two different things in the two places that must agree.
 *
 * Font sizes are in pixels *at the reference width* (1080), matching every
 * other caption metric, and are put through `scaled()` at render time.
 */
export const CaptionSettingsSchema = z.object({
  fontId: z.enum(CAPTION_FONT_IDS as unknown as [CaptionFontId, ...CaptionFontId[]]),
  hookFontSize: z.number().min(16).max(96),
  sizingFontSize: z.number().min(12).max(72),
  hookX: z.number().min(0).max(1),
  hookY: z.number().min(0).max(1),
  sizingX: z.number().min(0).max(1),
  sizingY: z.number().min(0).max(1),
  /** Hex fill for both blocks. The dark outline behind them is not configurable. */
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export type CaptionSettings = z.infer<typeof CaptionSettingsSchema>;

/**
 * What the renderer did before any of this was configurable.
 *
 * Kept as the literal previous values so an existing job, style or creator with
 * nothing saved renders exactly as it did — this feature must not silently
 * restyle work that already exists. `hookY` is 0.44 rather than 0.5 because the
 * hook has always sat a little above centre, per creator direction.
 */
export const DEFAULT_CAPTION_SETTINGS: CaptionSettings = {
  fontId: DEFAULT_CAPTION_FONT,
  hookFontSize: 36,
  sizingFontSize: 34,
  hookX: 0.5,
  hookY: 0.44,
  sizingX: 0.25,
  sizingY: 0.75,
  textColor: '#FFFFFF',
};

/** The old nine-ish placement names, as the fractions they always meant. */
const PLACEMENT_POSITIONS: Record<string, { x: number; y: number }> = {
  'top-left': { x: 0.25, y: 0.25 },
  'top-center': { x: 0.5, y: 0.25 },
  'top-right': { x: 0.75, y: 0.25 },
  'bottom-left': { x: 0.25, y: 0.75 },
  'bottom-center': { x: 0.5, y: 0.75 },
  'bottom-right': { x: 0.75, y: 0.75 },
};

/**
 * Converts a legacy placement name to sizing coordinates.
 *
 * The director still chooses a placement per variation, and styles still pin
 * one. Rather than migrate that away, it is translated here — so a saved
 * placement and a dragged position are the same thing by the time anything
 * draws, and only one positioning model exists downstream.
 */
export function positionForPlacement(placement: string | null | undefined): {
  sizingX: number;
  sizingY: number;
} {
  const found = PLACEMENT_POSITIONS[placement ?? ''] ?? PLACEMENT_POSITIONS['bottom-left'];
  return { sizingX: found.x, sizingY: found.y };
}

/**
 * Builds the settings a render should use, from the layers that can supply them.
 *
 * Later arguments win, which is the order of specificity the creator expects:
 * the built-in default is the floor, a style or profile supplies the look, and
 * anything tweaked for this one job sits on top. Each layer may be partial or
 * absent, and an invalid stored value is ignored rather than failing the render
 * — these columns are `jsonb` with no database-level shape.
 */
export function resolveCaptionSettings(
  ...layers: Array<unknown>
): CaptionSettings {
  let settings: CaptionSettings = { ...DEFAULT_CAPTION_SETTINGS };

  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    const parsed = CaptionSettingsSchema.partial().safeParse(layer);
    if (!parsed.success) continue;
    settings = { ...settings, ...stripUndefined(parsed.data) };
  }

  return settings;
}

/** `{...a, ...b}` would let an explicit `undefined` in `b` erase a real value in `a`. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}
