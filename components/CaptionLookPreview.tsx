'use client';

import type { CaptionSettings } from '@/lib/render/captionSettings';
import type { Grade } from '@/lib/jobView';

/** The @font-face families declared in globals.css, by caption font id. */
export const CAPTION_FONT_CSS: Record<string, string> = {
  roboto: 'CaptionRoboto',
  anton: 'CaptionAnton',
  bebas: 'CaptionBebas',
  poppins: 'CaptionPoppins',
};

export function captionFontFamily(fontId: string) {
  return `"${CAPTION_FONT_CSS[fontId] ?? 'CaptionRoboto'}", sans-serif`;
}

/**
 * A small, non-interactive preview of the creator's saved caption look.
 *
 * Positioned HTML rather than the canvas used in the flow: at 58px wide there
 * is no line breaking worth being exact about, and this only has to answer
 * "which typeface, what colour, roughly where". The flow's preview is the one
 * that has to agree with the renderer character for character.
 *
 * Font size is expressed at the 1080px reference width the settings use, then
 * scaled to whatever this preview is drawn at.
 */
export function CaptionLookPreview({
  settings,
  hook,
  sizing,
  width = 58,
  grade = 'a',
}: {
  settings: CaptionSettings;
  hook: string;
  sizing?: string | null;
  width?: number;
  grade?: Grade;
}) {
  const scale = width / 1080;

  return (
    <div className="thumb" data-grade={grade} style={{ width }}>
      <Block
        text={hook}
        x={settings.hookX}
        y={settings.hookY}
        size={settings.hookFontSize * scale}
        color={settings.textColor}
        fontId={settings.fontId}
      />
      {sizing && (
        <Block
          text={sizing}
          x={settings.sizingX}
          y={settings.sizingY}
          size={settings.sizingFontSize * scale}
          color={settings.textColor}
          fontId={settings.fontId}
        />
      )}
    </div>
  );
}

function Block({
  text,
  x,
  y,
  size,
  color,
  fontId,
}: {
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
  fontId: string;
}) {
  return (
    <span
      style={{
        position: 'absolute',
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        transform: 'translate(-50%, -50%)',
        width: '86%',
        fontFamily: captionFontFamily(fontId),
        // Floored so a small preview never renders sub-pixel text that
        // disappears entirely.
        fontSize: Math.max(4, size),
        lineHeight: 1.18,
        color,
        textAlign: 'center',
        // Stands in for the dark outline the renderer strokes behind the text.
        textShadow: '0 0 2px rgba(0,0,0,0.95), 0 1px 1px rgba(0,0,0,0.9)',
        pointerEvents: 'none',
      }}
    >
      {text}
    </span>
  );
}
