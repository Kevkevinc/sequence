'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

type Variation = {
  variationNumber: number;
  hookText: string;
  status: 'pending' | 'rendering' | 'done' | 'failed';
  durationSeconds: number | null;
  playbackUrl: string | null;
  failureReason: string | null;
};

type JobDetail = {
  id: string;
  productName: string;
  status: string;
  lengthSeconds: number;
  pacing: string;
  variationCount: number;
  warning: string | null;
  failureReason: string | null;
  createdAt: string;
  variations: Variation[];
};

const POLL_INTERVAL_MS = 5000;

/**
 * True while the job could still change state without a page reload.
 *
 * Checked on the job's own status, not the variations list: a job still in
 * tagging or planning has no `edit_plans` rows yet at all, so `variations` is
 * empty and would make a variations-only check stop polling immediately on a
 * job that has not even started rendering.
 */
function stillInProgress(job: JobDetail): boolean {
  return job.status !== 'done' && job.status !== 'failed';
}

export default function JobDetailPage() {
  const params = useParams<{ jobId: string }>();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const res = await fetch(`/api/jobs/${params.jobId}`);
        if (!res.ok) {
          throw new Error(
            res.status === 401
              ? 'You need to be signed in to see this video.'
              : res.status === 404
                ? 'This video does not exist, or is not yours.'
                : `Could not load this video (error ${res.status}). Please try again.`
          );
        }
        const data: JobDetail = await res.json();
        if (cancelled) return;

        setJob(data);
        setError(null);

        if (stillInProgress(data)) {
          timer = setTimeout(load, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load this video.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [params.jobId]);

  return (
    <main>
      <Link href="/jobs">&larr; Back to your videos</Link>

      {loading && <p>Loading...</p>}

      {!loading && error && <p style={{ color: 'red' }}>{error}</p>}

      {!loading && !error && job && (
        <>
          <h1>{job.productName}</h1>
          <p>
            {job.lengthSeconds}s, {job.pacing} pacing, {job.variationCount} variations requested —{' '}
            {job.status}
          </p>

          {job.warning && <p style={{ color: '#a15c00' }}>{job.warning}</p>}
          {job.status === 'failed' && job.failureReason && (
            <p style={{ color: 'red' }}>{job.failureReason}</p>
          )}

          <ul>
            {job.variations.map((variation) => (
              <li key={variation.variationNumber}>
                <p>
                  <strong>Variation {variation.variationNumber}</strong> — {variation.hookText}
                </p>

                {variation.status === 'pending' && <p>Waiting to render...</p>}
                {variation.status === 'rendering' && <p>Rendering...</p>}

                {variation.status === 'failed' && (
                  <p style={{ color: 'red' }}>
                    This variation could not be rendered
                    {variation.failureReason ? `: ${variation.failureReason}` : '.'}
                  </p>
                )}

                {variation.status === 'done' && variation.playbackUrl && (
                  <>
                    <video controls src={variation.playbackUrl} style={{ maxWidth: '320px' }}>
                      Your browser does not support video playback.
                    </video>
                    <p>
                      <a href={variation.playbackUrl} download>
                        Download
                      </a>
                      {variation.durationSeconds !== null && (
                        <> — {variation.durationSeconds.toFixed(1)}s</>
                      )}
                    </p>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
