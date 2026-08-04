'use client';

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
                {label}
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

          <div className="userChip">
            <UserButton
              appearance={{ elements: { avatarBox: { width: 34, height: 34 } } }}
            />
            <div style={{ minWidth: 0 }}>
              <div className="userName">{displayName}</div>
              <div className="userRole">Creator</div>
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
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
          </header>

          <main className="screen">{children}</main>
        </div>
      </div>
    </div>
  );
}
