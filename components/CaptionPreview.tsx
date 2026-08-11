'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { HEIGHT, WIDTH, scaled as scaleToFrame } from '@/lib/render/frame';
import { CAPTION_FONTS, captionFont } from '@/lib/render/fonts';
import type { CaptionSettings } from '@/lib/render/captionSettings';
import { anchorBlock, blockWidth, layoutTextBlock } from '@/lib/render/textLayout';

/**
 * A live, to-scale preview of the burned-in text over the creator's own footage.
 *
 * Draws with the same layout functions and the same font files the renderer
 * uses, at the same aspect ratio, then scales the whole canvas down. That is
 * the entire reason this is a canvas rather than positioned HTML: browser text
 * layout would wrap in different places than Skia does server-side, and a
 * preview that disagrees with the render about where a hook breaks is worse
 * than no preview at all.
 *
 * The backdrop is a real frame from a clip the creator just picked, read
 * locally from the File — no upload has happened yet at this point in the flow.
 */

/** Metrics the renderer applies that are not creator-controlled. */
const HOOK_LINE_HEIGHT = 1.18;
const SIZING_LINE_HEIGHT = 1.2;
const SIDE_MARGIN = scaleToFrame(120);
const EDGE_MARGIN = scaleToFrame(24);
const STROKE_RATIO = 0.12;

export type CaptionBlock = 'hook' | 'sizing';

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
    // Seeking past the very first frame avoids the black frame some phone
    // clips open on.
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

export function CaptionPreview({
  settings,
  hookText,
  sizingText,
  clip,
  selected,
  onSelect,
  onMove,
}: {
  settings: CaptionSettings;
  hookText: string;
  sizingText: string | null;
  /** A clip the creator picked, used as the backdrop. */
  clip: File | null;
  selected: CaptionBlock;
  onSelect: (block: CaptionBlock) => void;
  /** Reports a dragged position as fractions of the frame. */
  onMove: (block: CaptionBlock, x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [backdrop, setBackdrop] = useState<ImageBitmap | null>(null);
  const [fontsReady, setFontsReady] = useState(0);
  const dragging = useRef<CaptionBlock | null>(null);

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
      .then(() => {
        if (!cancelled) setFontsReady((n) => n + 1);
      })
      .catch(() => {
        // A font that will not load leaves the preview on the browser default
        // for that family. Worth drawing anyway: position and size are still
        // meaningful, and blocking the whole screen would be worse.
        if (!cancelled) setFontsReady((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Resolved rather than branched on, so the state write always happens in a
    // callback instead of synchronously in the effect body — the latter forces
    // an immediate second render on every clip change.
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
      ctx.fillStyle = '#1b1b1f';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = `${scaleToFrame(28)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('Pick your clips to preview over real footage', WIDTH / 2, HEIGHT / 2);
    }

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

      // A dashed box around whichever block is being edited, so it is obvious
      // what the sliders and the drag are acting on.
      if (block === selected) {
        ctx.save();
        ctx.setLineDash([14, 10]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(120,200,255,0.95)';
        ctx.strokeRect(
          laid.x - laid.width / 2 - 14,
          laid.top - 12,
          laid.width + 28,
          laid.blockHeight + 24
        );
        ctx.restore();
      }
    }
  }, [backdrop, hookText, sizingText, settings, selected, layoutFor, fontsReady]);

  /** Canvas-space coordinates from a pointer event, as frame fractions. */
  function fractionsFrom(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  function handleDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const { x, y } = fractionsFrom(event);
    // Pick whichever block's centre is nearer, so tapping the sizing text
    // selects it rather than always grabbing the hook.
    const toHook = Math.hypot(x - settings.hookX, y - settings.hookY);
    const toSizing = sizingText
      ? Math.hypot(x - settings.sizingX, y - settings.sizingY)
      : Infinity;
    const block: CaptionBlock = toSizing < toHook ? 'sizing' : 'hook';

    onSelect(block);
    dragging.current = block;
    event.currentTarget.setPointerCapture(event.pointerId);
    onMove(block, x, y);
  }

  function handleMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragging.current) return;
    const { x, y } = fractionsFrom(event);
    onMove(dragging.current, x, y);
  }

  function handleUp() {
    dragging.current = null;
  }

  return (
    <canvas
      ref={canvasRef}
      width={WIDTH}
      height={HEIGHT}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      aria-label={`Preview of ${captionFont(settings.fontId).label} captions over your footage`}
      style={{
        width: '100%',
        maxWidth: 300,
        aspectRatio: `${WIDTH} / ${HEIGHT}`,
        height: 'auto',
        borderRadius: 12,
        display: 'block',
        touchAction: 'none',
        cursor: 'grab',
        background: '#000',
      }}
    />
  );
}
