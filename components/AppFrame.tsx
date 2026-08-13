'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IconHome, IconPlus, IconUser, IconVideos } from '@/components/icons';

/**
 * The app shell.
 *
 * Sequence owns all of its navigation. Added to a home screen there is no
 * browser chrome and no system back button, so the shell supplies the nav and
 * every screen supplies its own way out. It is the same shell in a desktop
 * browser, a phone browser and an installed app: one column that fills the
 * height it is given. What changes between them is only what the *device* draws
 * around it, which is why there is no drawn bezel and no painted status bar
 * here. Those belong to the phone, and on a desktop they would be a picture of
 * one.
 */
export function AppFrame({
  children,
  /** The New Video flow owns the full screen and hides the nav. */
  showNav = true,
}: {
  children: React.ReactNode;
  showNav?: boolean;
}) {
  return (
    <div className="app">
      {children}
      {showNav && <BottomNav />}
    </div>
  );
}

/** The scrolling body of a screen. 118px of bottom padding clears the nav. */
export function Screen({
  children,
  /** Set on screens with their own sticky footer, which the nav is hidden for. */
  flush = false,
}: {
  children: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <div className="screen" data-flush={flush}>
      {children}
    </div>
  );
}

const NAV = [
  { href: '/', label: 'Home', Icon: IconHome },
  { href: '/jobs', label: 'Videos', Icon: IconVideos },
  { href: '/jobs/new', label: 'New', Icon: IconPlus },
  { href: '/profile', label: 'Profile', Icon: IconUser },
];

/**
 * `/jobs` must not light up while you are on `/jobs/new`, and `/` must not
 * light up for everything, so the root is matched exactly and the rest by
 * prefix.
 */
function isActive(href: string, pathname: string) {
  if (href === '/') return pathname === '/';
  if (href === '/jobs') return pathname === '/jobs' || /^\/jobs\/(?!new$)/.test(pathname);
  return pathname === href || pathname.startsWith(`${href}/`);
}

function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="nav">
      <div className="navBar">
        {NAV.map(({ href, label, Icon }) => (
          <Link
            key={href}
            href={href}
            className="navItem"
            data-active={isActive(href, pathname)}
          >
            <Icon size={22} />
            <span>{label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
