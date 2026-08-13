'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Thumb } from '@/components/Thumb';
import { estimateRemainingSeconds, formatRemaining } from '@/lib/estimate';
import { gradeFor, percentComplete, type JobSummary } from '@/lib/jobView';

/**
 * The densest card in the app, and the reason Home feels alive: a progress line
 * pinned to the card's top edge, the count, one tick bar per video, and an
 * estimate that keeps moving while the creator watches.
 */
export function RunningCard({ job }: { job: JobSummary }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const percent = percentComplete(job);
  const remaining = estimateRemainingSeconds(job, now);

  return (
    <Link
      href={`/jobs/${job.id}`}
      className="glass"
      data-feature="true"
      style={{ display: 'flex', gap: 15, padding: 16, alignItems: 'stretch' }}
    >
      <span className="progressLine" style={{ width: `${percent}%` }} />

      <Thumb src={job.thumbnailUrl} grade={gradeFor(job.id)} width={64} />

      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="listCardTitle" style={{ fontSize: 15.5 }}>
          {job.productName}
        </span>

        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{job.doneCount}</span>
          <span style={{ fontSize: 13, color: 'var(--text-meta)' }}>
            of {job.variationCount} ready
          </span>
        </span>

        <span className="ticks">
          {Array.from({ length: job.variationCount }, (_, index) => (
            <span key={index} className="tick" data-on={index < job.doneCount} />
          ))}
        </span>

        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="spinner" />
          <span style={{ fontSize: 12.5, color: 'var(--warning)' }}>
            {remaining === null ? 'Working' : formatRemaining(remaining)}
          </span>
        </span>
      </span>
    </Link>
  );
}
