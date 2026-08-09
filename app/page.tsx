'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { SignInButton, SignUpButton, useAuth } from '@clerk/nextjs';
import { AppShell } from '@/components/AppShell';
import { JobCard, type JobSummary } from '@/components/JobCard';
import { IconMute, IconPlus } from '@/components/icons';

export default function HomePage() {
  const { isLoaded, isSignedIn } = useAuth();
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    fetch('/api/jobs')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: JobSummary[]) => {
        if (!cancelled) setJobs(data);
      })
      .catch(() => {
        if (!cancelled) setJobs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  // Clerk resolves auth on the client; rendering either branch before it knows
  // would flash the signed-out landing at an already-signed-in creator.
  if (!isLoaded) return null;
  if (!isSignedIn) return <SignedOutLanding />;

  const ready = jobs?.filter((j) => j.status === 'done').length ?? 0;
  const rendering =
    jobs?.filter((j) => j.status !== 'done' && j.status !== 'failed').length ?? 0;

  return (
    <AppShell title="Home" subtitle="Your workspace at a glance">
      <div>
        <section className="glass card">
          <div className="eyebrow">For UGC creators</div>
          <h2 className="display" style={{ fontSize: 38, lineHeight: 1.08, marginTop: 14 }}>
            Your footage, cut and captioned.
          </h2>
          <p
            style={{
              marginTop: 14,
              fontSize: 15,
              lineHeight: 1.6,
              color: 'var(--text-2)',
              maxWidth: 520,
            }}
          >
            Upload your try-on footage. The AI picks the cuts, writes the hook, and burns it in.
            As many variations as you want, no editing.
          </p>

          <div style={{ display: 'flex', gap: 40, marginTop: 26 }}>
            <Stat label="videos" value={jobs?.length ?? 0} />
            <Stat label="ready" value={ready} />
            <Stat label="rendering" value={rendering} tone="var(--status-rendering)" />
          </div>

          <Link
            href="/jobs/new"
            className="btn btnAccent"
            style={{ display: 'inline-flex', marginTop: 26 }}
          >
            <IconPlus size={17} />
            New video
          </Link>
        </section>

        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            margin: '34px 0 16px',
          }}
        >
          <h3 className="display" style={{ fontSize: 20 }}>
            Recent videos
          </h3>
          <Link href="/jobs" style={{ color: 'var(--accent)', fontSize: 13.5, fontWeight: 700 }}>
            See all →
          </Link>
        </div>

        {jobs === null ? (
          <div style={{ color: 'var(--text-3)', fontSize: 14 }}>Loading…</div>
        ) : jobs.length === 0 ? (
          <div className="glass card" style={{ color: 'var(--text-3)', fontSize: 14 }}>
            No videos yet — start with{' '}
            <Link href="/jobs/new" style={{ color: 'var(--accent)', fontWeight: 700 }}>
              a new video
            </Link>
            .
          </div>
        ) : (
          <div className="grid">
            {jobs.slice(0, 6).map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className="display" style={{ fontSize: 28, color: tone }}>
        {value}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function SignedOutLanding() {
  return (
    <div className="appFrame">
      <div
        className="appFrameInner"
        style={{ gridTemplateColumns: '1fr', placeItems: 'center', padding: 24 }}
      >
        <span className="ambient ambientA" />
        <span className="ambient ambientB" />

        <div
          className="glass card"
          style={{
            position: 'relative',
            zIndex: 1,
            maxWidth: 460,
            textAlign: 'center',
            padding: 38,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 11,
              marginBottom: 22,
            }}
          >
            <span className="brandMark">S</span>
            <div style={{ textAlign: 'left' }}>
              <div className="brandName">Sequence</div>
              <div className="brandSub">UGC AI Editor</div>
            </div>
          </div>

          <h1 className="display" style={{ fontSize: 30, lineHeight: 1.1 }}>
            Your footage, cut and captioned.
          </h1>
          <p style={{ marginTop: 14, fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-2)' }}>
            Upload your try-on footage. The AI picks the cuts, writes the hook, and burns it in.
            As many variations as you want, no editing.
          </p>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 26 }}>
            <SignInButton>
              <button className="btn btnAccent">Sign in</button>
            </SignInButton>
            <SignUpButton>
              <button className="btn btnGhost">Create account</button>
            </SignUpButton>
          </div>

          <div className="silentCallout" style={{ marginTop: 26, textAlign: 'left' }}>
            <div className="silentTitle">
              <IconMute size={14} />
              Silent by design
            </div>
            <p className="silentBody">
              Every export is muted by default. Add your voiceover after.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
