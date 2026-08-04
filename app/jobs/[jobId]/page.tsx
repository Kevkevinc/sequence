'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { jobMetaLine } from '@/components/JobCard';
import {
  StatusBadge,
  Toast,
  VideoTile,
  hueFor,
  type JobStatus,
  type VariationStatus,
} from '@/components/ui';
import {
  IconChevronLeft,
  IconClock,
  IconDownload,
  IconError,
  IconWarning,
} from '@/components/icons';

type Variation = {
  variationNumber: number;
  hookText: string;
  status: VariationStatus;
  durationSeconds: number | null;
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  failureReason: string | null;
};

type JobDetail = {
  id: string;
  productName: string;
  status: JobStatus;
  lengthSeconds: number;
  pacing: 'slow' | 'medium' | 'fast' | null;
  styleName: string | null;
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

/** The pipeline the worker actually walks, in order. */
const PIPELINE: { status: JobStatus; label: string }[] = [
  { status: 'pending', label: 'Queued' },
  { status: 'tagging', label: 'Tagging clips' },
  { status: 'planning', label: 'Planning cuts' },
  { status: 'planned', label: 'Planned' },
  { status: 'rendering', label: 'Rendering' },
  { status: 'done', label: 'Done' },
];

export default function JobDetailPage() {
  const params = useParams<{ jobId: string }>();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const clearToast = useCallback(() => setToast(null), []);

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

  const doneVariations = job?.variations.filter((v) => v.status === 'done') ?? [];

  function downloadAll() {
    // No zip endpoint yet, so this opens each finished render in turn. The
    // browser treats them as separate downloads because each is a presigned
    // URL to a distinct object.
    for (const variation of doneVariations) {
      if (variation.playbackUrl) window.open(variation.playbackUrl, '_blank');
    }
    setToast(`Downloading ${doneVariations.length} video${doneVariations.length === 1 ? '' : 's'}`);
  }

  return (
    <AppShell title="Video" subtitle="Live status and results">
      {loading && <div style={{ color: 'var(--text-3)', fontSize: 14 }}>Loading…</div>}

      {!loading && error && (
        <div className="banner" data-tone="failed">
          {error}
        </div>
      )}

      {!loading && !error && job && (
        <div className="detailLayout">
          <section className="glass card detailInfo">
            <Link
              href="/jobs"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                color: 'var(--text-3)',
                marginBottom: 16,
              }}
            >
              <IconChevronLeft size={15} />
              All videos
            </Link>

            <h2 className="display" style={{ fontSize: 23, lineHeight: 1.15 }}>
              {job.productName}
            </h2>

            <div style={{ marginTop: 12 }}>
              <StatusBadge status={job.status} />
            </div>

            <div className="jobMeta" style={{ marginTop: 12 }}>
              {jobMetaLine(job)}
            </div>

            {stillInProgress(job) && (
              <div className="banner" data-tone="live" style={{ marginTop: 16 }}>
                <span className="liveDot" />
                Live — refreshing every 5s
              </div>
            )}

            {job.warning && (
              <div className="banner" data-tone="warning" style={{ marginTop: 12 }}>
                <IconWarning size={16} />
                <span>{job.warning}</span>
              </div>
            )}

            {job.status === 'failed' && job.failureReason && (
              <div className="banner" data-tone="failed" style={{ marginTop: 12 }}>
                <IconError size={16} />
                <span>{job.failureReason}</span>
              </div>
            )}

            <div style={{ marginTop: 24 }}>
              <Pipeline job={job} />
            </div>
          </section>

          <section>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                marginBottom: 18,
              }}
            >
              <h3 className="display" style={{ fontSize: 20 }}>
                Variations
              </h3>
              {doneVariations.length > 0 && (
                <button className="btn btnAccent" onClick={downloadAll}>
                  <IconDownload size={16} />
                  Download all ({doneVariations.length})
                </button>
              )}
            </div>

            {job.variations.length === 0 ? (
              <div className="glass card" style={{ color: 'var(--text-3)', fontSize: 14 }}>
                The AI is still planning the cuts — variations show up here as soon as they
                exist.
              </div>
            ) : (
              <div className="variationGrid">
                {job.variations.map((variation) => (
                  <VariationCard
                    key={variation.variationNumber}
                    variation={variation}
                    onDownloaded={() => setToast('Download started')}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {toast && <Toast message={toast} onDone={clearToast} />}
    </AppShell>
  );
}

function Pipeline({ job }: { job: JobDetail }) {
  const currentIndex = PIPELINE.findIndex((step) => step.status === job.status);

  return (
    <div>
      {PIPELINE.map((step, index) => {
        const isLast = index === PIPELINE.length - 1;

        let state: 'upcoming' | 'done' | 'active' | 'failed' = 'upcoming';
        if (job.status === 'failed') {
          // A failed job stops wherever it got to; the exact stage isn't stored,
          // so mark the whole run failed at the top rather than guessing.
          state = index === 0 ? 'failed' : 'upcoming';
        } else if (currentIndex === -1) {
          state = 'upcoming';
        } else if (index < currentIndex) {
          state = 'done';
        } else if (index === currentIndex) {
          // A finished job's last step is completed, not still working.
          state = job.status === 'done' ? 'done' : 'active';
        }

        return (
          <div key={step.status} className="pipeStep" data-state={state}>
            <div className="pipeRail">
              <span className="pipeDot" />
              {!isLast && <span className="pipeLine" />}
            </div>
            <div className="pipeLabel">
              {step.label}
              {state === 'active' && <div className="pipeNote">in progress</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VariationCard({
  variation,
  onDownloaded,
}: {
  variation: Variation;
  onDownloaded: () => void;
}) {
  return (
    <div className="glass card" style={{ padding: 14 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--text-3)' }}
        >
          VAR {variation.variationNumber}
        </span>
        <StatusBadge status={variation.status} />
      </div>

      {variation.status === 'done' && variation.playbackUrl && (
        <>
          <VideoTile
            src={variation.playbackUrl}
            poster={variation.thumbnailUrl}
            hue={hueFor(variation.variationNumber)}
          />

          {variation.hookText && (
            <p
              className="display"
              style={{ fontSize: 13.5, lineHeight: 1.3, marginTop: 11 }}
            >
              {variation.hookText}
            </p>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 10,
              fontSize: 12.5,
              color: 'var(--text-3)',
            }}
          >
            <IconClock size={14} />
            {variation.durationSeconds !== null
              ? `${variation.durationSeconds.toFixed(0)}s`
              : '—'}
          </div>

          <a
            href={variation.playbackUrl}
            download
            onClick={onDownloaded}
            className="btn btnGhost btnFull"
            style={{ marginTop: 12 }}
          >
            <IconDownload size={16} />
            Download
          </a>
        </>
      )}

      {variation.status === 'rendering' && (
        <>
          <div
            className="videoTile skeleton"
            style={{ display: 'grid', placeItems: 'center', animation: 'none', background: 'rgba(255,255,255,.06)' }}
          >
            <span className="spinner" />
          </div>
          <p style={{ marginTop: 11, fontSize: 12.5, color: 'var(--text-3)' }}>
            Rendering &amp; burning in the hook…
          </p>
        </>
      )}

      {variation.status === 'pending' && (
        <>
          <div
            className="videoTile"
            style={{
              display: 'grid',
              placeItems: 'center',
              animation: 'none',
              background: 'transparent',
              border: '1.5px dashed rgba(255,255,255,.18)',
            }}
          >
            <span
              className="badgeDot"
              style={{
                background: 'var(--status-queued)',
                animation: 'pulseDot 1.3s ease-in-out infinite',
              }}
            />
          </div>
          <p style={{ marginTop: 11, fontSize: 12.5, color: 'var(--text-3)' }}>
            Waiting in queue
          </p>
        </>
      )}

      {variation.status === 'failed' && (
        <>
          <div
            className="videoTile"
            style={{
              display: 'grid',
              placeItems: 'center',
              animation: 'none',
              background: 'rgba(255,110,110,.1)',
              border: '1px solid rgba(255,140,140,.3)',
              color: 'var(--status-failed)',
            }}
          >
            <IconError size={26} />
          </div>
          <p style={{ marginTop: 11, fontSize: 12.5, color: 'var(--status-failed)', lineHeight: 1.45 }}>
            {variation.failureReason ?? 'This variation could not be rendered.'}
          </p>
        </>
      )}
    </div>
  );
}
