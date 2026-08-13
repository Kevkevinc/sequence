'use client';

import { useState } from 'react';
import type { Grade } from '@/lib/jobView';

/**
 * A 9:16 video thumbnail. Never any other aspect.
 *
 * With a real frame it shows the frame: the hook is already burned into those
 * pixels, so nothing is drawn over it. Without one it falls back to the job's
 * duotone grade and draws the hook the way the renderer will, which is what
 * makes a queue of pending videos look like videos rather than empty boxes.
 */
export function Thumb({
  src,
  hook,
  grade = 'a',
  width,
  className = '',
  style,
  children,
}: {
  src?: string | null;
  /** Only drawn over a placeholder; a real frame already carries it. */
  hook?: string | null;
  grade?: Grade;
  /** Width in px. Height follows from the 9:16 aspect. */
  width?: number;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const frame = src && !failed ? src : null;

  return (
    <div
      className={`thumb ${className}`}
      data-grade={grade}
      style={{ width, ...style }}
    >
      {frame ? (
        /*
         * An <img>, not a <video>: a card needs one frame, and pulling a whole
         * 18MB render down to paint it would be absurd. `onError` covers
         * renders made before thumbnails existed, which 404 and fall back to
         * the grade.
         */
        // eslint-disable-next-line @next/next/no-img-element
        <img src={frame} alt="" onError={() => setFailed(true)} />
      ) : (
        hook && <span className="thumbHook">{hook.toUpperCase()}</span>
      )}
      {children}
    </div>
  );
}
