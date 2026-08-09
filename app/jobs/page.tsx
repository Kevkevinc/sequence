'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { JobCard, type JobSummary } from '@/components/JobCard';
import { IconVideos } from '@/components/icons';

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/jobs');
        if (!res.ok) {
          throw new Error(
            res.status === 401
              ? 'You need to be signed in to see your videos.'
              : `Could not load your videos (error ${res.status}). Please try again.`
          );
        }
        const data = await res.json();
        if (!cancelled) setJobs(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load your videos.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell title="Your videos" subtitle="Everything you've made">
      {loading && <div style={{ color: 'var(--text-3)', fontSize: 14 }}>Loading…</div>}

      {!loading && error && (
        <div className="banner" data-tone="failed">
          {error}
        </div>
      )}

      {!loading && !error && jobs.length === 0 && (
        <div className="emptyState">
          <span className="emptyIcon glass">
            <IconVideos size={26} />
          </span>
          <h2 className="display" style={{ fontSize: 21 }}>
            No videos yet
          </h2>
          <p style={{ fontSize: 14, color: 'var(--text-3)', maxWidth: 330, lineHeight: 1.55 }}>
            Upload a clip and Sequence sends back a few cuts ready to post.
          </p>
          <Link href="/jobs/new" className="btn btnAccent" style={{ marginTop: 4 }}>
            Create your first video
          </Link>
        </div>
      )}

      {!loading && !error && jobs.length > 0 && (
        <div className="grid">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </AppShell>
  );
}
