'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IconHome, IconPlus, IconUser, IconVideos } from '@/components/icons';

/**
 * Works out whether the safe-area insets still need paying for.
 *
 * There are two ways an installed iOS app can be handed the screen, and they
 * need opposite treatment. Either it gets the whole thing, in which case the
 * app must keep its own content out of the status bar and the home indicator by
 * padding by the reported insets. Or the system keeps those strips for itself
 * and hands over what is left, while *still* reporting the insets, in which
 * case padding by them again leaves a gap twice the size at each end. That is
 * the case this measures: if the window is meaningfully shorter than the
 * screen, the room has already been taken, so the padding is zeroed and the
 * layout below reads the same two variables either way.
 */
function useSafeAreaInsets() {
  useEffect(() => {
    const root = document.documentElement;

    function apply() {
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as unknown as { standalone?: boolean }).standalone === true;

      // Only trusted while installed. A browser tab is legitimately shorter
      // than the screen, by however much the toolbars happen to be taking.
      const reserved = window.screen.height - window.innerHeight;
      const alreadyReserved = standalone && reserved > 20;

      root.style.setProperty(
        '--safe-top',
        alreadyReserved ? '0px' : 'env(safe-area-inset-top)'
      );
      root.style.setProperty(
        '--safe-bottom',
        alreadyReserved ? '0px' : 'env(safe-area-inset-bottom)'
      );
    }

    apply();
    // Rotation and the iOS toolbars both change the answer.
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, []);
}

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
  useSafeAreaInsets();

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
