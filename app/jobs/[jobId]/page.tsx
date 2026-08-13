'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PhoneFrame, Screen } from '@/components/PhoneFrame';
import { StatusBadge } from '@/components/StatusMarker';
import { StageTimeline } from '@/components/StageTimeline';
import { ResultCell } from '@/components/ResultCell';
import { NotifyWhenReady } from '@/components/NotifyWhenReady';
import { IconChevronLeft } from '@/components/icons';
import { displayStatus, isRunning, type JobDetail } from '@/lib/jobView';

const POLL_MS = 5000;

export default function JobDetailPage() {
  const params = useParams<{ jobId: string }>();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);

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
                : 'This video could not be loaded. Check your connection and try again.'
          );
        }
        const data: JobDetail = await res.json();
        if (cancelled) return;

        setJob(data);
        setError(null);
        if (isRunning(data.status)) timer = setTimeout(load, POLL_MS);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    }

    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [params.jobId]);

  if (error) {
    return (
      <PhoneFrame>
        <Screen>
          <BackLink />
          <div className="panel" data-tone="failure" style={{ marginTop: 20 }}>
            <p className="panelText">{error}</p>
          </div>
        </Screen>
      </PhoneFrame>
    );
  }

  if (!job) {
    return (
      <PhoneFrame>
        <Screen>
          <BackLink />
          <p className="meta" style={{ marginTop: 20 }}>
            Loading this video.
          </p>
        </Screen>
      </PhoneFrame>
    );
  }

  const done = job.variations.filter((v) => v.status === 'done');
  const status = displayStatus({
    status: job.status,
    variationCount: job.variationCount,
    doneCount: done.length,
  });
  const running = isRunning(job.status);
  const total = job.variationCount;

  const gridTitle =
    status === 'working'
      ? `Ready so far · ${done.length} of ${total}`
      : status === 'partial'
        ? `${done.length} of ${total} made it`
        : `Your ${done.length} video${done.length === 1 ? '' : 's'}`;

  const how =
    job.kind === 'talking'
      ? 'talking to camera'
      : (job.styleName ?? `${job.pacing ?? 'custom'} pacing`);
  const metaLine = [
    `${job.lengthSeconds}s`,
    how,
    job.kind === 'talking'
      ? '1 video'
      : `${total} variation${total === 1 ? '' : 's'}`,
  ].join(' · ');

  /*
   * Opens every finished video at once. Mobile browsers block windows after the
   * first, so this is a convenience on desktop and each cell keeps its own
   * Download button, which is what works on a phone. A server-side zip would be
   * one request but lands as a 300MB archive in Files that still has to be
   * unzipped and saved to Photos one video at a time, which is worse.
   */
  function downloadAll() {
    for (const variation of done) {
      if (variation.downloadUrl) window.open(variation.downloadUrl, '_blank');
    }
  }

  return (
    <PhoneFrame>
      <header className="detailHeader">
        <BackLink />
        <h1 className="detailTitle" style={{ marginTop: 10 }}>
          {job.productName}
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <StatusBadge status={status} />
          <span className="meta">{metaLine}</span>
        </div>
      </header>

      <Screen>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 16 }}>
          {running && <StageTimeline job={job} doneCount={done.length} />}

          {running && <NotifyWhenReady />}

          {job.warning && (
            <div className="panel" data-tone="warning">
              <p className="panelText">{job.warning}</p>
            </div>
          )}

          {status === 'partial' && (
            <div className="panel" data-tone="warning">
              <p className="panelText">
                {done.length} of {total} videos rendered. The rest hit an error on the way out.
                The ones below are finished and safe to post.
              </p>
            </div>
          )}

          {status === 'failed' && (
            <div className="panel" data-tone="failure">
              <p className="panelText">
                {job.failureReason ??
                  'This job could not be finished, so no videos came out of it.'}
              </p>
              <Link
                href="/jobs/new"
                className="btn btnSmall"
                style={{ marginTop: 12, display: 'inline-flex' }}
              >
                Start a new video
              </Link>
            </div>
          )}

          {status !== 'failed' && (
            <section>
              <div className="sectionLabelRow" style={{ marginBottom: 14 }}>
                <span className="sectionLabel">{gridTitle}</span>
                {(status === 'done' || status === 'partial') && done.length > 1 && (
                  <button type="button" className="btn btnSmall" onClick={downloadAll}>
                    All
                  </button>
                )}
              </div>

              {job.variations.length === 0 ? (
                <p className="meta">
                  The cuts are still being planned. Your videos appear here as they render.
                </p>
              ) : (
                <div className="resultGrid">
                  {job.variations.map((variation) => (
                    <ResultCell
                      key={variation.variationNumber}
                      variation={variation}
                      playing={playing === variation.variationNumber}
                      onPlay={() => setPlaying(variation.variationNumber)}
                      onStop={() => setPlaying(null)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </Screen>
    </PhoneFrame>
  );
}

function BackLink() {
  return (
    <Link
      href="/jobs"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 13,
        color: 'var(--text-meta)',
        minHeight: 44,
      }}
    >
      <IconChevronLeft size={15} />
      All videos
    </Link>
  );
}
