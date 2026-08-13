'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AppFrame, Screen } from '@/components/AppFrame';
import { JobRow } from '@/components/JobRow';
import { useJobs } from '@/lib/useJobs';
import { displayStatus, type DisplayStatus } from '@/lib/jobView';

type Filter = 'all' | 'working' | 'done' | 'failed';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'working', label: 'Working' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
];

/** Done covers partly done: both have videos to download, which is the point. */
function matches(filter: Filter, status: DisplayStatus) {
  if (filter === 'all') return true;
  if (filter === 'done') return status === 'done' || status === 'partial';
  return status === filter;
}

export default function JobsPage() {
  return (
    // useSearchParams needs a Suspense boundary to keep the route static.
    <Suspense fallback={<AppFrame><Screen>{null}</Screen></AppFrame>}>
      <Jobs />
    </Suspense>
  );
}

function Jobs() {
  const params = useSearchParams();
  // Home's "See all N" link lands here already filtered to what is running.
  const initial = params.get('filter');
  const [filter, setFilter] = useState<Filter>(
    FILTERS.some((f) => f.value === initial) ? (initial as Filter) : 'all'
  );
  const { jobs, error } = useJobs();

  const shown = (jobs ?? []).filter((job) => matches(filter, displayStatus(job)));

  return (
    <AppFrame>
      <Screen>
        <h1 className="screenTitle" style={{ padding: '10px 0 18px' }}>
          Your videos
        </h1>

        <div className="chipRow" style={{ marginBottom: 20 }}>
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="chip"
              data-active={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="panel" data-tone="failure">
            <p className="panelText">{error}</p>
          </div>
        )}

        {jobs === null && !error && <p className="meta">Loading your videos.</p>}

        {jobs !== null && shown.length === 0 && (
          <div className="emptyState">
            <p className="cardDesc">
              {jobs.length === 0
                ? 'Nothing here yet. Upload a few clips and Sequence sends back finished cuts.'
                : 'Nothing in this filter right now.'}
            </p>
            {jobs.length === 0 && (
              <Link
                href="/jobs/new"
                className="btn"
                data-pill="true"
                style={{ marginTop: 16 }}
              >
                Make your first video
              </Link>
            )}
          </div>
        )}

        {shown.length > 0 && (
          <div className="list">
            {shown.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </div>
        )}
      </Screen>
    </AppFrame>
  );
}
