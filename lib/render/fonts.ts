/**
 * The typefaces a creator can pick for burned-in text.
 *
 * Deliberately a small, closed set rather than a free text field. Every entry
 * has to exist as a committed TTF the renderer can load by path — the
 * production host has no font directory, so a family the server cannot resolve
 * would render as a fallback the creator never chose (see SOURCE.txt). A closed
 * set also means the preview can be trusted: the browser is served the same
 * file the renderer uses.
 *
 * All four are bold or naturally heavy. Thin type does not survive TikTok's
 * re-encode at caption size, so offering a light weight would mostly be
 * offering a way to make an unreadable video.
 */
export const CAPTION_FONTS = [
  {
    id: 'roboto',
    label: 'Roboto',
    description: 'Neutral and highly readable. The safe default.',
    file: 'Roboto-Bold.ttf',
  },
  {
    id: 'anton',
    label: 'Anton',
    description: 'Tall, condensed and loud — fits long hooks on one line.',
    file: 'Anton-Regular.ttf',
  },
  {
    id: 'bebas',
    label: 'Bebas Neue',
    description: 'All-caps condensed. Reads as sport/streetwear.',
    file: 'BebasNeue-Regular.ttf',
  },
  {
    id: 'poppins',
    label: 'Poppins',
    description: 'Round geometric sans. Softer, common in beauty content.',
    file: 'Poppins-Bold.ttf',
  },
] as const;

export type CaptionFontId = (typeof CAPTION_FONTS)[number]['id'];

export const CAPTION_FONT_IDS = CAPTION_FONTS.map((f) => f.id) as readonly CaptionFontId[];

export const DEFAULT_CAPTION_FONT: CaptionFontId = 'roboto';

/**
 * Resolves an id to its font entry, falling back to the default.
 *
 * Never throws on an unknown id: these values arrive from a database column
 * that predates this feature and from request bodies, and a caption in the
 * wrong-but-readable typeface is a far better outcome than a failed render.
 */
export function captionFont(id: string | null | undefined) {
  return CAPTION_FONTS.find((f) => f.id === id) ?? CAPTION_FONTS[0];
}
