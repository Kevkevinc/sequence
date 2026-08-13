'use client';

import Link from 'next/link';
import { SignInButton, SignUpButton, useAuth, useUser } from '@clerk/nextjs';
import { PhoneFrame, Screen } from '@/components/PhoneFrame';
import { JobRow } from '@/components/JobRow';
import { RunningCard } from '@/components/RunningCard';
import { IconPlus, LogoMark } from '@/components/icons';
import { useJobs } from '@/lib/useJobs';
import { isRunning } from '@/lib/jobView';

export default function HomePage() {
  const { isLoaded, isSignedIn } = useAuth();

  // Clerk resolves auth on the client, and rendering either branch before it
  // knows would flash the signed-out screen at a creator who is signed in.
  if (!isLoaded) return <PhoneFrame showNav={false}><Screen>{null}</Screen></PhoneFrame>;
  if (!isSignedIn) return <SignedOut />;
  return <Home />;
}

function Home() {
  const { user } = useUser();
  const { jobs, error } = useJobs();

  const running = jobs?.filter((job) => isRunning(job.status)) ?? [];
  const recent = (jobs ?? []).filter((job) => !isRunning(job.status)).slice(0, 3);
  const initial =
    (user?.firstName || user?.username || user?.primaryEmailAddress?.emailAddress || 'S')
      .charAt(0)
      .toUpperCase();

  return (
    <PhoneFrame>
      <Screen>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 0 18px',
          }}
        >
          <LogoMark size={30} />
          <Link href="/profile" className="avatar" aria-label="Your profile">
            {initial}
          </Link>
        </header>

        <h1 className="hero">
          Edit less.
          <br />
          <span className="heroGradient">Post more.</span>
        </h1>

        <p className="heroBody" style={{ margin: '14px 0 26px' }}>
          Drop in raw clips. Get back finished vertical videos, already cut and captioned.
        </p>

        <Link
          href="/jobs/new"
          className="glass"
          data-feature="true"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: 22,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: 19,
                fontWeight: 600,
                letterSpacing: '-0.01em',
              }}
            >
              New video
            </span>
            <span className="cardDesc" style={{ display: 'block', marginTop: 5, fontSize: 13.5 }}>
              Silent cuts, or one take talking to camera
            </span>
          </span>
          <span
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 46,
              height: 46,
              flexShrink: 0,
              borderRadius: 999,
              background: '#fff',
              color: '#000',
            }}
          >
            <IconPlus size={20} />
          </span>
        </Link>

        {error && (
          <div className="panel" data-tone="failure" style={{ marginTop: 26 }}>
            <p className="panelText">{error}</p>
          </div>
        )}

        {running.length > 0 && (
          <section style={{ marginTop: 30 }}>
            <div className="sectionLabelRow" style={{ marginBottom: 14 }}>
              <span className="sectionLabel">
                <span
                  className="markerDot"
                  style={{ color: 'var(--warning)', animation: 'pulseDot 1.4s ease infinite' }}
                />
                Running now
              </span>
              {running.length > 1 && (
                <Link href="/jobs?filter=working" className="linkAccent">
                  See all {running.length}
                </Link>
              )}
            </div>
            <RunningCard job={running[0]} />
          </section>
        )}

        <section style={{ marginTop: 30 }}>
          <div className="sectionLabelRow" style={{ marginBottom: 14 }}>
            <span className="sectionLabel">
              <span className="markerDot" style={{ color: '#fff' }} />
              Recent
            </span>
            <Link href="/jobs" className="linkAccent">
              All videos
            </Link>
          </div>

          {jobs === null ? (
            <p className="meta">Loading your videos.</p>
          ) : recent.length === 0 ? (
            <div className="emptyState">
              <p className="cardDesc">
                {running.length > 0
                  ? 'Your first videos land here as soon as they finish.'
                  : 'Nothing here yet. Upload a few clips and Sequence sends back finished cuts.'}
              </p>
            </div>
          ) : (
            <div className="list">
              {recent.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </div>
          )}
        </section>
      </Screen>
    </PhoneFrame>
  );
}

/**
 * What a creator sees before signing in. Same headline and same frame, because
 * this is the product's one identifying screen and it should be the first thing
 * they see.
 */
function SignedOut() {
  return (
    <PhoneFrame showNav={false}>
      <Screen flush>
        <header style={{ padding: '6px 0 26px' }}>
          <LogoMark size={30} />
        </header>

        <h1 className="hero">
          Edit less.
          <br />
          <span className="heroGradient">Post more.</span>
        </h1>

        <p className="heroBody" style={{ margin: '14px 0 30px' }}>
          Drop in raw clips. Get back finished vertical videos, already cut and captioned.
          Silent edits you voice over, or one take talking to camera.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SignInButton>
            <button className="btn btnFull" data-pill="true">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton>
            <button className="btn btnOutline btnFull" data-pill="true">
              Create an account
            </button>
          </SignUpButton>
        </div>

        <p className="footnote" style={{ marginTop: 20 }}>
          Add Sequence to your home screen and it opens like an app, with no address bar.
        </p>
      </Screen>
    </PhoneFrame>
  );
}
