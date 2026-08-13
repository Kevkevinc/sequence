'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IconHome, IconPlus, IconUser, IconVideos } from '@/components/icons';

/**
 * Works out whether the status bar still needs paying for.
 *
 * An installed iOS app is either handed the whole screen, in which case it has
 * to keep its own content out from under the clock, or handed everything below
 * the status bar, in which case the system has already done that and padding by
 * the reported inset would leave a second, empty status bar's worth of space.
 * Both happen, and the app cannot know which in advance, so it measures: a
 * window shorter than the screen means the room has already been taken.
 *
 * Only the top is decided this way. The home indicator strip sits inside the
 * window in both arrangements, so its inset is always paid.
 */
export function useSafeAreaInsets() {
  useEffect(() => {
    const root = document.documentElement;

    /*
     * Read as pixels off a probe element rather than passed through as an
     * `env()` expression.
     *
     * Storing `env(safe-area-inset-top)` in a custom property and substituting
     * it with `var()` looks equivalent and is not: Safari does not resolve it,
     * the declaration is dropped, and the padding silently computes to zero.
     * That is why content sat under the clock on a device that was reporting a
     * 59px inset perfectly well. Measuring the probe and writing back a plain
     * number sidesteps the substitution entirely.
     */
    function readInsets() {
      const probe = document.createElement('div');
      probe.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        'visibility:hidden',
        'pointer-events:none',
        'padding-top:env(safe-area-inset-top)',
        'padding-bottom:env(safe-area-inset-bottom)',
      ].join(';');
      document.body.appendChild(probe);
      const style = getComputedStyle(probe);
      const insets = {
        top: parseFloat(style.paddingTop) || 0,
        bottom: parseFloat(style.paddingBottom) || 0,
      };
      probe.remove();
      return insets;
    }

    function apply() {
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as unknown as { standalone?: boolean }).standalone === true;

      // Only trusted while installed. A browser tab is legitimately shorter
      // than the screen, by however much the toolbars happen to be taking.
      const reserved = window.screen.height - window.innerHeight;
      const systemTookTheStatusBar = standalone && reserved > 20;
      const insets = readInsets();

      root.style.setProperty('--safe-top', systemTookTheStatusBar ? '0px' : `${insets.top}px`);
      root.style.setProperty('--safe-bottom', `${insets.bottom}px`);
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
