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
  downloadUrl: string | null;
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
  clipCount: number;
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

/**
 * The pipeline the worker actually walks, in order, with a plain-language note
 * about what is happening and roughly how long it takes.
 *
 * The waits here are minutes, not seconds — tagging alone measures ~2.5min on
 * real phone footage. Without saying so, a creator watching a spinner assumes
 * it has hung and reloads or gives up.
 */
const PIPELINE: { status: JobStatus; label: string; detail: string }[] = [
  { status: 'pending', label: 'Queued', detail: 'Waiting for a free slot.' },
  {
    status: 'tagging',
    label: 'Tagging clips',
    detail: 'The AI is watching your footage to find the usable moments. Usually 2-3 minutes.',
  },
  {
    status: 'planning',
    label: 'Planning cuts',
    detail: 'Choosing the cuts and writing the hooks. Around 10 seconds.',
  },
  { status: 'planned', label: 'Planned', detail: 'Cuts decided, about to render.' },
  {
    status: 'rendering',
    label: 'Rendering',
    detail: 'Cutting and exporting each video at full quality. Around 2-3 minutes each.',
  },
  { status: 'done', label: 'Done', detail: 'All videos ready to download.' },
];

/**
 * Rough per-stage costs, from timing real jobs on the render machine.
 *
 * Tagging dominates and scales per clip: each one is downloaded, uploaded to
 * Gemini and analysed. Rendering is per variation and went up when the encoder
 * moved to a higher quality target. These are estimates shown as "about N
 * minutes left" — never a countdown, because the real number depends on
 * footage size and how busy the machine is.
 */
const ESTIMATE = {
  taggingSecondsPerClip: 55,
  planningSeconds: 12,
  renderSecondsPerVariation: 150,
};

/**
 * Seconds still to go, or null once there is nothing left to wait for.
 *
 * Self-correcting where it can be: once variations start finishing, the
 * measured pace of *this* job replaces the constant, so a slow machine or
 * unusually long clips stop being systematically underestimated.
 */
function estimateRemainingSeconds(job: JobDetail, now: number): number | null {
  if (!stillInProgress(job)) return null;

  const elapsed = (now - new Date(job.createdAt).getTime()) / 1000;
  const done = job.variations.filter((v) => v.status === 'done').length;
  const remainingVariations = Math.max(0, job.variationCount - done);

  if (job.status === 'rendering' && done > 0) {
    // Everything before the first finished render was setup; the rest is pace.
    const perVariation = elapsed / done;
    return Math.round(remainingVariations * Math.min(perVariation, ESTIMATE.renderSecondsPerVariation * 3));
  }

  const aiTotal =
    job.clipCount * ESTIMATE.taggingSecondsPerClip + ESTIMATE.planningSeconds;
  const renderTotal = remainingVariations * ESTIMATE.renderSecondsPerVariation;
  const aiRemaining =
    job.status === 'rendering' || job.status === 'planned' ? 0 : Math.max(0, aiTotal - elapsed);

  return Math.round(aiRemaining + renderTotal);
}

/** "about 4 minutes left" — deliberately coarse, because the estimate is. */
function formatRemaining(seconds: number): string {
  if (seconds < 45) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'} left`;
}

/** Elapsed time in a shape a person reads at a glance: "4m 12s", not "252s". */
function formatElapsed(fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

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
      if (variation.downloadUrl) window.open(variation.downloadUrl, '_blank');
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

            {stillInProgress(job) && (
              <div style={{ marginTop: 18 }}>
                <LiveStatus job={job} />
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
                /*
                 * Desktop only. This opens one window per video, and mobile
                 * browsers block every window after the first — so on a phone
                 * the button appeared to do nothing, or silently saved one of
                 * five. Each variation has its own Download button that does
                 * work there, which is what a tester fell back to anyway.
                 *
                 * A server-side zip would be one request, but 5x67MB lands as a
                 * 300MB archive in Files that still has to be unzipped and
                 * saved to Photos one video at a time — worse than tapping
                 * five buttons.
                 */
                <button className="btn btnAccent desktopOnly" onClick={downloadAll}>
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

/**
 * The one-line answer to "is this thing still working?".
 *
 * The pipeline below shows *where* a job is; this shows that it is still
 * moving, with a running clock and a count of finished videos. Renders now
 * take ~1.5 minutes each, so a five-variation job runs for the better part of
 * ten minutes — long enough that silence reads as a crash.
 */
function LiveStatus({ job }: { job: JobDetail }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Ticks independently of the 5s data poll so the clock moves every second.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const ready = job.variations.filter((v) => v.status === 'done').length;
  const rendering = job.variations.find((v) => v.status === 'rendering');
  const step = PIPELINE.find((s) => s.status === job.status);
  const remaining = estimateRemainingSeconds(job, now);

  const headline =
    job.status === 'rendering' && rendering
      ? `Rendering video ${rendering.variationNumber} of ${job.variationCount}`
      : (step?.label ?? 'Working');

  return (
    <div className="glass card liveStatus">
      <div className="liveStatusTop">
        <span className="spinner" style={{ width: 16, height: 16 }} />
        <strong>{headline}</strong>
        <span className="liveClock">{formatElapsed(job.createdAt, now)}</span>
      </div>
      {remaining !== null && <p className="liveEta">{formatRemaining(remaining)}</p>}
      <p className="liveStatusDetail">{step?.detail}</p>
      {job.variationCount > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="progressTrack">
            <div
              className="progressFill"
              style={{ width: `${Math.round((ready / job.variationCount) * 100)}%` }}
            />
          </div>
          <p className="helper" style={{ marginTop: 6 }}>
            {ready} of {job.variationCount} videos ready
            {ready > 0 ? ' — you can download the finished ones now' : ''}
          </p>
        </div>
      )}
    </div>
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
              {/* The explanation only appears on the step that is actually
                  running — showing all six at once is a wall of text. */}
              {state === 'active' && <div className="pipeNote">{step.detail}</div>}
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

          {/*
            No `download` attribute: it is ignored cross-origin, and R2 is a
            different origin. The presigned URL carries the attachment
            disposition instead, which is what makes this work on a phone.
          */}
          <a
            href={variation.downloadUrl ?? undefined}
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
