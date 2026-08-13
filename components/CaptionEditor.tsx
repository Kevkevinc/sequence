'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { HEIGHT, WIDTH, scaled as scaleToFrame } from '@/lib/render/frame';
import { CAPTION_FONTS } from '@/lib/render/fonts';
import type { CaptionSettings } from '@/lib/render/captionSettings';
import { anchorBlock, blockWidth, layoutTextBlock } from '@/lib/render/textLayout';
import { MAX_CAPTION_PT, MIN_CAPTION_PT, fromPt, toPt } from '@/lib/captionUnits';

/**
 * Where on-screen text goes, and what it looks like.
 *
 * The stage is a canvas rather than positioned HTML, and that is the whole
 * point of it: the browser wraps text in different places than Skia does
 * server-side, so an HTML preview would show a hook breaking after a word the
 * real video breaks before. This draws with the same layout functions, the same
 * font files and the same aspect ratio the renderer uses, then scales the
 * result down to 216px.
 *
 * Dragging moves the block under the finger rather than snapping its centre to
 * the pointer, so a small nudge stays a small nudge. Positions are stored as
 * fractions of the frame and clamped well inside it, because a caption 80%
 * visible reads as a bug rather than a choice.
 */

const HOOK_LINE_HEIGHT = 1.18;
const SIZING_LINE_HEIGHT = 1.2;
const SIDE_MARGIN = scaleToFrame(120);
const EDGE_MARGIN = scaleToFrame(24);
const STROKE_RATIO = 0.12;

/** How far a block may be dragged, as fractions of the frame. */
const CLAMP_X = [0.06, 0.94] as const;
const CLAMP_Y = [0.05, 0.95] as const;

const STAGE_WIDTH = 216;

export type CaptionBlock = 'hook' | 'sizing';

/** The five burn-in colours. Anything else is a font choice, not a colour one. */
const COLOURS = ['#FFFFFF', '#000000', '#00D2FF', '#F59E0B', '#FF5F8F'];

/** Pulls a frame out of a local video file, as a bitmap the canvas can draw. */
async function frameFromFile(file: File, atSeconds = 0.5): Promise<ImageBitmap | null> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;

    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('could not read video'));
    });
    // Seeking past the very first frame avoids the black frame some phone clips
    // open on.
    video.currentTime = Math.min(atSeconds, (video.duration || 1) / 2);
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
    });

    return await createImageBitmap(video);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

type Rect = { x: number; y: number; width: number; height: number };

export function CaptionEditor({
  settings,
  onChange,
  hookText,
  onHookTextChange,
  sizingText,
  clip,
  clipLabel,
  footer,
}: {
  settings: CaptionSettings;
  onChange: (patch: Partial<CaptionSettings>) => void;
  hookText: string;
  /** Omitted where the hook is not editable, as on the saved-look screen. */
  onHookTextChange?: (value: string) => void;
  sizingText: string | null;
  /** A clip the creator just picked, used as the backdrop. */
  clip?: File | null;
  clipLabel?: string;
  footer?: React.ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [backdrop, setBackdrop] = useState<ImageBitmap | null>(null);
  const [fontsReady, setFontsReady] = useState(0);
  const [selected, setSelected] = useState<CaptionBlock>('hook');

  /** Where each block landed on the last draw, in frame pixels. Hit-tested on drag. */
  const rects = useRef<Partial<Record<CaptionBlock, Rect>>>({});
  const drag = useRef<{ block: CaptionBlock; offsetX: number; offsetY: number } | null>(null);

  // Load every caption font once, so switching family redraws instantly rather
  // than flashing a fallback while a 170KB file downloads.
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      CAPTION_FONTS.map(async (font) => {
        const face = new FontFace(`UgcFont-${font.id}`, `url(/api/fonts/${font.id})`);
        await face.load();
        document.fonts.add(face);
      })
    )
      .catch(() => {
        // A font that will not load leaves the stage on the browser default for
        // that family. Still worth drawing: position and size remain meaningful.
      })
      .finally(() => {
        if (!cancelled) setFontsReady((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(clip ? frameFromFile(clip) : null).then((bitmap) => {
      if (!cancelled) setBackdrop(bitmap);
    });
    return () => {
      cancelled = true;
    };
  }, [clip]);

  /** Lays out one block exactly as the renderer will, in frame pixels. */
  const layoutFor = useCallback(
    (ctx: CanvasRenderingContext2D, block: CaptionBlock) => {
      const isHook = block === 'hook';
      const text = isHook ? hookText : (sizingText ?? '');
      const fontSize = scaleToFrame(isHook ? settings.hookFontSize : settings.sizingFontSize);
      ctx.font = `${fontSize}px "UgcFont-${settings.fontId}"`;

      const measure = (value: string) => ctx.measureText(value).width;
      const laid = layoutTextBlock({
        text,
        fontSize,
        lineHeightRatio: isHook ? HOOK_LINE_HEIGHT : SIZING_LINE_HEIGHT,
        maxWidth: WIDTH - SIDE_MARGIN,
        measure,
      });
      const width = blockWidth(laid.lines, measure);
      const { x, top } = anchorBlock({
        centreXFraction: isHook ? settings.hookX : settings.sizingX,
        centreYFraction: isHook ? settings.hookY : settings.sizingY,
        blockWidth: width,
        blockHeight: laid.blockHeight,
        frameWidth: WIDTH,
        frameHeight: HEIGHT,
        marginPx: EDGE_MARGIN,
      });
      return { ...laid, fontSize, width, x, top };
    },
    [hookText, sizingText, settings]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    if (backdrop) {
      // Crop-to-fill, matching the renderer's reframe so the creator sees the
      // same part of their footage the video will use.
      const scale = Math.max(WIDTH / backdrop.width, HEIGHT / backdrop.height);
      const w = backdrop.width * scale;
      const h = backdrop.height * scale;
      ctx.drawImage(backdrop, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
    } else {
      const grade = ctx.createLinearGradient(0, 0, WIDTH * 0.4, HEIGHT);
      grade.addColorStop(0, '#13294d');
      grade.addColorStop(1, '#0a0f1a');
      ctx.fillStyle = grade;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }

    const next: Partial<Record<CaptionBlock, Rect>> = {};

    for (const block of ['sizing', 'hook'] as CaptionBlock[]) {
      const text = block === 'hook' ? hookText : sizingText;
      if (!text || !text.trim()) continue;

      const laid = layoutFor(ctx, block);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.92)';
      ctx.lineWidth = Math.round(laid.fontSize * STROKE_RATIO);
      ctx.fillStyle = settings.textColor;

      for (const [index, line] of laid.lines.entries()) {
        const y = laid.top + index * laid.lineHeight;
        ctx.strokeText(line, laid.x, y);
        ctx.fillText(line, laid.x, y);
      }

      const pad = scaleToFrame(14);
      const rect: Rect = {
        x: laid.x - laid.width / 2 - pad,
        y: laid.top - pad,
        width: laid.width + pad * 2,
        height: laid.blockHeight + pad * 2,
      };
      next[block] = rect;

      /*
       * Both blocks are outlined at the same width, and only the colour
       * changes. Drawing the outline on just one would shift the other by a
       * pixel when selection moved, which reads as the text jumping.
       */
      ctx.save();
      ctx.lineWidth = 1.5 * (WIDTH / STAGE_WIDTH);
      ctx.strokeStyle = block === selected ? '#00d2ff' : 'transparent';
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      ctx.restore();
    }

    rects.current = next;
  }, [backdrop, hookText, sizingText, settings, selected, layoutFor, fontsReady]);

  /** Pointer position as fractions of the frame. */
  function fractionsFrom(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  function centreOf(block: CaptionBlock) {
    return block === 'hook'
      ? { x: settings.hookX, y: settings.hookY }
      : { x: settings.sizingX, y: settings.sizingY };
  }

  function moveTo(block: CaptionBlock, x: number, y: number) {
    const clampedX = Math.min(Math.max(x, CLAMP_X[0]), CLAMP_X[1]);
    const clampedY = Math.min(Math.max(y, CLAMP_Y[0]), CLAMP_Y[1]);
    onChange(
      block === 'hook'
        ? { hookX: clampedX, hookY: clampedY }
        : { sizingX: clampedX, sizingY: clampedY }
    );
  }

  function handleDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const point = fractionsFrom(event);

    // Whichever block was actually touched. Falling back to the nearer centre
    // means a tap in empty space still picks something sensible rather than
    // doing nothing.
    let block: CaptionBlock | null = null;
    for (const candidate of ['hook', 'sizing'] as CaptionBlock[]) {
      const rect = rects.current[candidate];
      if (!rect) continue;
      const px = point.x * WIDTH;
      const py = point.y * HEIGHT;
      if (px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height) {
        block = candidate;
        break;
      }
    }
    if (!block) {
      const toHook = Math.hypot(point.x - settings.hookX, point.y - settings.hookY);
      const toSizing = sizingText
        ? Math.hypot(point.x - settings.sizingX, point.y - settings.sizingY)
        : Infinity;
      block = toSizing < toHook ? 'sizing' : 'hook';
    }

    const centre = centreOf(block);
    setSelected(block);
    drag.current = {
      block,
      offsetX: centre.x - point.x,
      offsetY: centre.y - point.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const current = drag.current;
    if (!current) return;
    const point = fractionsFrom(event);
    moveTo(current.block, point.x + current.offsetX, point.y + current.offsetY);
  }

  function handleUp() {
    drag.current = null;
  }

  const isHook = selected === 'hook';
  const sizePt = toPt(isHook ? settings.hookFontSize : settings.sizingFontSize);
  const across = isHook ? settings.hookX : settings.sizingX;
  const down = isHook ? settings.hookY : settings.sizingY;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div className="captionStage" style={{ background: '#000' }}>
          <canvas
            ref={canvasRef}
            width={WIDTH}
            height={HEIGHT}
            onPointerDown={handleDown}
            onPointerMove={handleMove}
            onPointerUp={handleUp}
            onPointerCancel={handleUp}
            aria-label="Drag your on-screen text to place it"
            style={{
              width: '100%',
              height: '100%',
              display: 'block',
              touchAction: 'none',
              cursor: 'grab',
            }}
          />
          {clipLabel && (
            <span className="cellChip" style={{ fontSize: 9.5 }}>
              {clipLabel}
            </span>
          )}
        </div>
        <p className="footnote" style={{ marginTop: 10, textAlign: 'center' }}>
          Drag text to place it. Tap a block to edit it.
        </p>
      </div>

      <div className="segmented">
        {(['hook', 'sizing'] as CaptionBlock[]).map((block) => (
          <button
            key={block}
            type="button"
            className="segment"
            data-active={selected === block}
            disabled={block === 'sizing' && !sizingText}
            style={{ opacity: block === 'sizing' && !sizingText ? 0.4 : 1 }}
            onClick={() => setSelected(block)}
          >
            {block === 'hook' ? 'Hook' : 'Sizing info'}
          </button>
        ))}
      </div>

      {isHook && onHookTextChange && (
        <div>
          <p className="sectionLabel" style={{ marginBottom: 10 }}>
            Hook text
          </p>
          <input
            className="field"
            value={hookText}
            onChange={(e) => onHookTextChange(e.target.value)}
            aria-label="Hook text"
          />
          <p className="footnote" style={{ marginTop: 8 }}>
            Sequence writes the real hook for each video. This one is here so you can see where
            it lands and how big it reads.
          </p>
        </div>
      )}

      <div>
        <p className="sectionLabel" style={{ marginBottom: 10 }}>
          Typeface
        </p>
        <div className="chipRow">
          {CAPTION_FONTS.map((font) => (
            <button
              key={font.id}
              type="button"
              className="chip"
              data-active={settings.fontId === font.id}
              onClick={() => onChange({ fontId: font.id })}
              style={{ fontFamily: `"UgcFont-${font.id}", sans-serif`, fontSize: 15 }}
            >
              {font.label}
            </button>
          ))}
        </div>
      </div>

      <Slider
        label="Size"
        value={sizePt}
        display={`${sizePt}pt`}
        min={MIN_CAPTION_PT}
        max={MAX_CAPTION_PT}
        step={1}
        bounds={[`${MIN_CAPTION_PT}pt`, `${MAX_CAPTION_PT}pt`]}
        onChange={(value) =>
          onChange(isHook ? { hookFontSize: fromPt(value) } : { sizingFontSize: fromPt(value) })
        }
      />

      <Slider
        label="Across"
        value={Math.round(across * 100)}
        display={`${Math.round(across * 100)}%`}
        min={CLAMP_X[0] * 100}
        max={CLAMP_X[1] * 100}
        step={1}
        bounds={['Left', 'Right']}
        onChange={(value) => moveTo(selected, value / 100, down)}
      />

      <Slider
        label="Down"
        value={Math.round(down * 100)}
        display={`${Math.round(down * 100)}%`}
        min={CLAMP_Y[0] * 100}
        max={CLAMP_Y[1] * 100}
        step={1}
        bounds={['Top', 'Bottom']}
        onChange={(value) => moveTo(selected, across, value / 100)}
      />

      <div>
        <p className="sectionLabel" style={{ marginBottom: 10 }}>
          Colour
        </p>
        <div style={{ display: 'flex', gap: 12 }}>
          {COLOURS.map((colour) => (
            <button
              key={colour}
              type="button"
              className="swatch"
              data-active={settings.textColor.toUpperCase() === colour}
              style={{ background: colour }}
              aria-label={`Caption colour ${colour}`}
              onClick={() => onChange({ textColor: colour })}
            />
          ))}
        </div>
      </div>

      {footer}
    </div>
  );
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  bounds,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  bounds: [string, string];
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="sectionLabelRow" style={{ marginBottom: 4 }}>
        <span className="sectionLabel">{label}</span>
        <span className="sliderValue">{display}</span>
      </div>
      <input
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="sliderBounds">
        <span>{bounds[0]}</span>
        <span>{bounds[1]}</span>
      </div>
    </div>
  );
}
