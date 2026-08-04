'use client';

import Link from 'next/link';
import { IconChevronRight } from '@/components/icons';
import { StatusBadge, VideoTile, hueFor, type JobStatus } from '@/components/ui';

export type JobSummary = {
  id: string;
  productName: string;
  status: JobStatus;
  lengthSeconds: number;
  pacing: 'slow' | 'medium' | 'fast' | null;
  styleName?: string | null;
  variationCount: number;
  /** A finished render to still-frame as the card thumbnail; null until one exists. */
  thumbnailUrl?: string | null;
};

/** A job is labelled by its style when it has one, and by its pacing otherwise. */
export function jobMetaLine(job: JobSummary, includeVariations = true) {
  const parts = [`${job.lengthSeconds}s`, job.styleName ?? `${job.pacing ?? 'custom'} pacing`];
  if (includeVariations) {
    parts.push(`${job.variationCount} variation${job.variationCount === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

function inProgress(status: JobStatus) {
  return status !== 'done' && status !== 'failed';
}

export function JobCard({ job }: { job: JobSummary }) {
  return (
    <Link href={`/jobs/${job.id}`} className="jobCard glass">
      <div style={{ position: 'relative', width: 66, flexShrink: 0 }}>
        <VideoTile
          poster={job.thumbnailUrl}
          hue={hueFor(job.productName.length + job.variationCount)}
          showPlay={false}
          showChrome={false}
        />
        {inProgress(job.status) && (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              background: 'rgba(0,0,0,.35)',
              borderRadius: 16,
            }}
          >
            <span className="spinner" style={{ width: 18, height: 18 }} />
          </span>
        )}
      </div>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="jobTitle">{job.productName}</div>
        <div className="jobMeta">{jobMetaLine(job)}</div>
        <div style={{ marginTop: 9 }}>
          <StatusBadge status={job.status} />
        </div>
      </div>

      <span style={{ color: 'var(--text-faint)' }}>
        <IconChevronRight size={18} />
      </span>
    </Link>
  );
}
