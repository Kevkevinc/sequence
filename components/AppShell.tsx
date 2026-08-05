'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton, useUser } from '@clerk/nextjs';
import {
  IconHome,
  IconMute,
  IconPlus,
  IconUser,
  IconVideos,
} from '@/components/icons';

const NAV = [
  { href: '/', label: 'Home', Icon: IconHome },
  { href: '/jobs', label: 'Your videos', Icon: IconVideos },
  { href: '/jobs/new', label: 'New video', Icon: IconPlus },
  { href: '/profile', label: 'Profile', Icon: IconUser },
];

/**
 * `/jobs` must not light up while you are on `/jobs/new`, and `/` must not
 * light up for everything — so the root is matched exactly and the rest by
 * prefix, longest first.
 */
function isActive(href: string, pathname: string) {
  if (href === '/') return pathname === '/';
  if (href === '/jobs') return pathname === '/jobs' || /^\/jobs\/(?!new$)/.test(pathname);
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  title,
  subtitle,
  children,
  /** New Video hides the top-bar CTA that would just reload the page it is on. */
  showNewVideoAction = true,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  showNewVideoAction?: boolean;
}) {
  const pathname = usePathname();
  const { user } = useUser();

  /*
   * Everyone signing up during the beta is labelled a beta tester. Read from
   * the creator row rather than assumed, so this keeps telling the truth once
   * the cohort default flips to `public` and the two kinds of account coexist.
   * Falls back to the plain role while loading, or if the request fails —
   * a missing badge is better than a wrong one.
   */
  const [cohort, setCohort] = useState<'beta' | 'public' | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetch('/api/profile')
      .then((res) => (res.ok ? res.json() : null))
      .then((profile) => {
        if (!cancelled && profile?.cohort) setCohort(profile.cohort);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user]);

  const displayName =
    user?.username ||
    user?.primaryEmailAddress?.emailAddress?.split('@')[0] ||
    user?.firstName ||
    'Creator';

  return (
    <div className="appFrame">
      <div className="appFrameInner">
        <span className="ambient ambientA" />
        <span className="ambient ambientB" />

        <aside className="sidebar">
          <div className="brand">
            <span className="brandMark">C</span>
            <div style={{ minWidth: 0 }}>
              <div className="brandName">Cutloop</div>
              <div className="brandSub">UGC AI Editor</div>
            </div>
          </div>

          <nav className="nav">
            {NAV.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                className="navItem"
                data-active={isActive(href, pathname)}
              >
                <Icon size={19} />
                {/* Wrapped so narrow phones can drop to an icon-only bar. */}
                <span className="navLabel">{label}</span>
              </Link>
            ))}
          </nav>

          <div className="silentCallout">
            <div className="silentTitle">
              <IconMute size={14} />
              Silent by design
            </div>
            <p className="silentBody">
              Every export is muted by default. Add your voiceover after.
            </p>
          </div>

          {/* Which build a tester is actually running — the first thing worth
              knowing when a bug report and the current code disagree. */}
          <div className="versionTag">v{process.env.NEXT_PUBLIC_APP_VERSION}</div>

          <div className="userChip">
            <UserButton
              appearance={{ elements: { avatarBox: { width: 34, height: 34 } } }}
            />
            <div style={{ minWidth: 0 }}>
              <div className="userName">{displayName}</div>
              <div className="userRole" data-cohort={cohort ?? undefined}>
                {cohort === 'beta' ? 'Beta tester' : 'Creator'}
              </div>
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <div className="topbarInner">
              <div style={{ minWidth: 0 }}>
                <h1 className="pageTitle">{title}</h1>
                {subtitle && <div className="pageSubtitle">{subtitle}</div>}
              </div>
              {showNewVideoAction && (
                <Link href="/jobs/new" className="btn btnAccent">
                  <IconPlus size={17} />
                  New video
                </Link>
              )}
            </div>
          </header>

          <main className="screen">
            {/*
              One centred column for every screen, rather than each page
              stretching its cards the full width of a wide monitor — which
              is what left all that dead space inside the boxes.
            */}
            <div className="screenInner">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
