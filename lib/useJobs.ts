'use client';

import { useEffect, useState } from 'react';
import { isRunning, type JobSummary } from '@/lib/jobView';

const POLL_MS = 5000;

/**
 * The creator's jobs, refreshed while any of them is still running.
 *
 * Polling stops the moment nothing is in flight, so a library of finished
 * videos costs one request rather than one every five seconds forever. The
 * timer is chained off the response rather than set on an interval, so a slow
 * request never stacks a queue of them behind it.
 */
export function useJobs() {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const res = await fetch('/api/jobs');
        if (!res.ok) {
          throw new Error(
            res.status === 401
              ? 'You need to be signed in to see your videos.'
              : 'Your videos could not be loaded. Check your connection and try again.'
          );
        }
        const data: JobSummary[] = await res.json();
        if (cancelled) return;

        setJobs(Array.isArray(data) ? data : []);
        setError(null);

        if (data.some((job) => isRunning(job.status))) {
          timer = setTimeout(load, POLL_MS);
        }
      } catch (err) {
        if (!cancelled) {
          setJobs((current) => current ?? []);
          setError(err instanceof Error ? err.message : 'Your videos could not be loaded.');
        }
      }
    }

    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return { jobs, error };
}
