import { z } from 'zod';
import { OVERLAY_PLACEMENTS } from '@/lib/editPlan';

/**
 * A style's whole editing recipe, stored as `styles.config` (JSONB).
 *
 * A flexible blob rather than one column per technique: a new technique later
 * is a new key here plus the code that acts on it, not a schema migration.
 * Each known key is still hand-interpreted code, never a generic rules engine.
 */
export const StyleConfigSchema = z.object({
  /** The "ideal" per-cut range this style's edits aim for, before pacing tolerance widens it. */
  cutMinSeconds: z.number().positive(),
  cutMaxSeconds: z.number().positive(),
  /** Replaces the global HOOK_STYLE_LIBRARY for jobs using this style. */
  /*
   * Either bare strings or `{text, audience}` entries. The union keeps rows
   * seeded before hooks carried an audience readable — an untagged string is
   * treated as `any`, which is what it effectively was.
   */
  hookStyleLibrary: z
    .array(
      z.union([
        z.string(),
        z.object({ text: z.string(), audience: z.enum(['mens', 'womens', 'any']) }),
      ])
    )
    .min(1),
  /** Hex color for hook/sizing text. Unset = today's default (white fill, black outline). */
  textColor: z.string().optional(),
  /** Pins sizing text to one corner for every variation of this style, instead of letting the director pick freely. */
  sizingPlacement: z.enum(OVERLAY_PLACEMENTS).optional(),
  /** Whether the director rotates each variation between b-roll-first / try-on-first / mixed clip ordering. */
  variesClipOrder: z.boolean(),
  /** Whether job creation asks for one inspiration photo, composited early in the render. */
  usesInspirationOverlay: z.boolean(),
});

export type StyleConfig = z.infer<typeof StyleConfigSchema>;
