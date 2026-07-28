'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type Job = {
  id: string;
  productName: string;
  status: string;
  lengthSeconds: number;
  pacing: string;
  variationCount: number;
  createdAt: string;
};

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
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
    <main>
      <h1>Your Videos</h1>
      <Link href="/jobs/new">+ New Video</Link>

      {loading && <p>Loading...</p>}

      {!loading && error && <p style={{ color: 'red' }}>{error}</p>}

      {!loading && !error && jobs.length === 0 && <p>You have not created any videos yet.</p>}

      {!loading && !error && jobs.length > 0 && (
        <ul>
          {jobs.map((job) => (
            <li key={job.id}>
              {job.productName} — {job.lengthSeconds}s, {job.pacing} pacing, {job.variationCount}{' '}
              variations — {job.status}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
