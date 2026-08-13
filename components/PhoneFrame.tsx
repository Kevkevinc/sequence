'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  IconBattery,
  IconHome,
  IconPlus,
  IconSignal,
  IconUser,
  IconVideos,
  IconWifi,
} from '@/components/icons';

/**
 * The app frame.
 *
 * Sequence owns all of its navigation: there is no browser chrome to fall back
 * on and no system back button, so the frame supplies the status bar, the
 * floating nav and the home indicator, and every screen supplies its own way
 * out. On a phone (below 560px) the CSS drops the drawn bezel and this fills
 * the viewport instead, because a bezel inside a real phone is just a smaller
 * phone.
 */
export function PhoneFrame({
  children,
  /** The New Video flow owns the full screen and hides the nav. */
  showNav = true,
}: {
  children: React.ReactNode;
  showNav?: boolean;
}) {
  return (
    <div className="desk">
      <div className="frame">
        <StatusBar />
        {children}
        {showNav && <BottomNav />}
        <div className="homeIndicator" />
      </div>
    </div>
  );
}

function StatusBar() {
  /*
   * Starts on the design's canonical 9:41 and switches to the real clock after
   * mount. Rendering the real time on the server would differ from the client's
   * by whatever the request took, which React reports as a hydration mismatch.
   */
  const [time, setTime] = useState('9:41');

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      // No AM/PM: a phone status bar does not show it, and the extra glyphs
      // would push the clock into the signal icons.
      const hour = now.getHours() % 12 || 12;
      setTime(`${hour}:${String(now.getMinutes()).padStart(2, '0')}`);
    };
    tick();
    const timer = setInterval(tick, 20_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="statusBar" aria-hidden="true">
      <span>{time}</span>
      <span className="statusGlyphs">
        <IconSignal />
        <IconWifi />
        <IconBattery />
      </span>
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
