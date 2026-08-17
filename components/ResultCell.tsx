'use client';

import { useState } from 'react';
import { Thumb } from '@/components/Thumb';
import { IconClose, IconDownload, IconPlay } from '@/components/icons';
import { gradeFor, type Variation } from '@/lib/jobView';
import { saveVideo } from '@/lib/saveVideo';

/**
 * One cell of the results grid, in whichever of its three states applies.
 *
 * A pending cell is not an empty box: it carries the hook the director already
 * wrote for that variation, so a job mid-render looks like the videos it is
 * about to become.
 */
export function ResultCell({
  variation,
  fileName,
  playing,
  onPlay,
  onStop,
}: {
  variation: Variation;
  /** Human name for the saved file, e.g. "Cloud Slides v2". */
  fileName: string;
  playing: boolean;
  onPlay: () => void;
  onStop: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  if (variation.status === 'done' && variation.playbackUrl) {
    return (
      <div>
        <div className="resultCell" style={{ background: 'transparent' }}>
          {playing ? (
            <>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                src={variation.playbackUrl}
                poster={variation.thumbnailUrl ?? undefined}
                controls
                autoPlay
                playsInline
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
              />
              <button
                type="button"
                onClick={onStop}
                aria-label="Close player"
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  display: 'grid',
                  placeItems: 'center',
                  width: 26,
                  height: 26,
                  borderRadius: 999,
                  background: 'rgba(0,0,0,0.55)',
                }}
              >
                <IconClose size={14} />
              </button>
            </>
          ) : (
            <>
              <Thumb
                src={variation.thumbnailUrl}
                hook={variation.hookText}
                grade={gradeFor(variation.variationNumber)}
                style={{ position: 'absolute', inset: 0, width: '100%', borderRadius: 15 }}
              />
              <button
                type="button"
                onClick={onPlay}
                aria-label={`Play video ${variation.variationNumber}`}
                style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}
              >
                <span className="playButton">
                  <IconPlay size={18} />
                </span>
              </button>
              <span className="cellChip">{variation.variationNumber}</span>
              {variation.durationSeconds !== null && (
                <span className="cellDuration">{Math.round(variation.durationSeconds)}s</span>
              )}
            </>
          )}
        </div>

        <button
          type="button"
          /*
           * Not a link to R2: a cross-origin navigation bounces a standalone PWA
           * out to an in-app browser. This hands the video to the OS share sheet
           * instead — "Save Video" to Photos — and only falls back to a direct
           * download where sharing is unavailable. See {@link saveVideo}.
           */
          className="btn btnOutline btnFull btnSmall"
          style={{ marginTop: 8 }}
          disabled={saving || !variation.playbackUrl}
          onClick={async () => {
            if (!variation.playbackUrl) return;
            setSaving(true);
            setProgress(null);
            try {
              await saveVideo(
                {
                  url: variation.playbackUrl,
                  downloadUrl: variation.downloadUrl,
                  name: fileName,
                },
                (fraction) => setProgress(fraction)
              );
            } finally {
              setSaving(false);
              setProgress(null);
            }
          }}
        >
          <IconDownload size={14} />
          {saving
            ? progress !== null
              ? `Saving ${Math.round(progress * 100)}%`
              : 'Saving…'
            : 'Download'}
        </button>
      </div>
    );
  }

  if (variation.status === 'failed') {
    return (
      <div
        className="resultCell"
        style={{
          gap: 8,
          background: 'var(--failure-fill)',
          border: '1px solid var(--failure-border)',
          color: 'var(--failure-text)',
        }}
      >
        <IconClose size={22} />
        <span style={{ fontSize: 12 }}>Did not render</span>
      </div>
    );
  }

  return (
    <div className="resultCell" style={{ gap: 10, border: '1px dashed rgba(255,255,255,0.14)' }}>
      <span className="spinner" data-tone="accent" style={{ width: 20, height: 20 }} />
      <span className="meta">Rendering</span>
    </div>
  );
}
