'use client';

import Link from 'next/link';
import { Thumb } from '@/components/Thumb';
import { StatusMarker } from '@/components/StatusMarker';
import { IconChevronRight } from '@/components/icons';
import { countLine, displayStatus, gradeFor, styleLine, type JobSummary } from '@/lib/jobView';

/**
 * One job in a list: thumbnail, title, status, and two meta lines. Shared by
 * Home's Recent block and the Your videos screen so the two cannot describe the
 * same job differently.
 */
export function JobRow({ job }: { job: JobSummary }) {
  return (
    <Link href={`/jobs/${job.id}`} className="glass listCard">
      <Thumb src={job.thumbnailUrl} grade={gradeFor(job.id)} width={58} />

      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span className="listCardTitle">{job.productName}</span>
        <StatusMarker status={displayStatus(job)} />
        <span className="meta">{countLine(job)}</span>
        <span className="meta">{styleLine(job)}</span>
      </span>

      <span style={{ color: 'var(--text-disabled)' }}>
        <IconChevronRight size={18} />
      </span>
    </Link>
  );
}
