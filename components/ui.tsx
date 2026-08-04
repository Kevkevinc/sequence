'use client';

import { useEffect } from 'react';
import { IconCheck, IconMute, IconPlay } from '@/components/icons';

/* ------------------------------------------------------------- statuses --- */

/** Every job/variation status the API can return, in pipeline order. */
export type JobStatus =
  | 'pending'
  | 'tagging'
  | 'planning'
  | 'planned'
  | 'rendering'
  | 'done'
  | 'failed';

export type VariationStatus = 'pending' | 'rendering' | 'done' | 'failed';

/**
 * Collapses the seven job statuses onto the four visual tones the design
 * defines. Everything before rendering reads as "queued" — the creator does
 * not need to distinguish tagging from planning at a glance, only "not started
 * yet" from "working" from "ready".
 */
export function statusTone(status: JobStatus | VariationStatus) {
  if (status === 'done') return 'ready' as const;
  if (status === 'failed') return 'failed' as const;
  if (status === 'rendering') return 'rendering' as const;
  return 'queued' as const;
}

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'Queued',
  tagging: 'Tagging',
  planning: 'Planning',
  planned: 'Planned',
  rendering: 'Rendering',
  done: 'Ready',
  failed: 'Failed',
};

export function StatusBadge({ status }: { status: JobStatus | VariationStatus }) {
  return (
    <span className="badge" data-tone={statusTone(status)}>
      <span className="badgeDot" />
      {STATUS_LABEL[status as JobStatus] ?? status}
    </span>
  );
}

/* ---------------------------------------------------------------- video --- */

/**
 * Spreads placeholder hues around the wheel so sibling variations look
 * distinct while a job is still rendering. Deterministic in the variation
 * number, so a tile does not change colour between polls.
 */
export function hueFor(n: number) {
  return (n * 67 + 210) % 360;
}

export type SizingPreview = {
  height?: string | null;
  weight?: string | null;
  sizeWorn?: string | null;
  /** Dupe Flip pins its overlay bottom-left; everything else bottom-right. */
  side?: 'left' | 'right';
};

/**
 * A 9:16 tile. With `src` it plays the real render; without one it shows the
 * drifting gradient placeholder. The overlays here are a *preview* of what the
 * renderer burns in — on a finished video the real text is already in the
 * pixels, so they are only drawn for placeholders.
 */
export function VideoTile({
  src,
  hue = 260,
  hook,
  sizing,
  showPlay = true,
  /**
   * Off for list thumbnails: at 66px wide the MUTED chip and sizing block are
   * both wider than the tile and spill over its rounded corners.
   */
  showChrome = true,
  className = '',
  style,
}: {
  src?: string | null;
  hue?: number;
  hook?: string | null;
  sizing?: SizingPreview | null;
  showPlay?: boolean;
  showChrome?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const sizingLines = sizing
    ? [
        sizing.height?.trim() || null,
        sizing.weight?.trim() || null,
        sizing.sizeWorn?.trim() ? `Size ${sizing.sizeWorn.trim()}` : null,
      ].filter((line): line is string => Boolean(line))
    : [];

  return (
    <div
      className={`videoTile ${className}`}
      style={{ ['--hue' as string]: hue, ...style }}
    >
      {src ? (
        <video src={src} controls playsInline preload="metadata" />
      ) : (
        <>
          {showChrome && (
            <>
              <span className="mutedChip">
                <IconMute size={11} />
                MUTED
              </span>

              {sizingLines.length > 0 && (
                <div className="sizingOverlay" data-side={sizing?.side ?? 'right'}>
                  {sizingLines.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </div>
              )}
            </>
          )}

          {showPlay && (
            <span className="playButton">
              <IconPlay size={20} />
            </span>
          )}

          <span className="videoScrim" />
          {showChrome && hook && <span className="videoHook">{hook}</span>}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- toast --- */

export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 2000);
    return () => clearTimeout(timer);
  }, [message, onDone]);

  return (
    <div className="toast" role="status">
      <span className="toastCheck">
        <IconCheck size={13} />
      </span>
      {message}
    </div>
  );
}
