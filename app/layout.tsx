import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { NoiseFilter } from '@/components/NoiseFilter';
import './globals.css';

/**
 * Inter carries the whole interface. The four caption typefaces are not loaded
 * here: they are served from `/api/fonts/*` as the same files the renderer
 * draws with, and declared as @font-face in globals.css.
 */
const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800', '900'],
});

export const metadata: Metadata = {
  title: 'Sequence',
  description:
    'Drop in raw clips. Get back finished vertical videos, already cut and captioned.',
  appleWebApp: {
    // Removes Safari's browser chrome once a creator adds Sequence to their
    // home screen, which is the whole point of shipping this as a PWA.
    capable: true,
    title: 'Sequence',
    statusBarStyle: 'black-translucent',
  },
  other: {
    /*
     * `capable: true` above emits the standard `mobile-web-app-capable`, which
     * is the modern spelling and the one Android reads. iOS does not read it.
     * Apple's rule is that `apple-mobile-web-app-status-bar-style` is honoured
     * *only* when `apple-mobile-web-app-capable` is present, so without this
     * line black-translucent is silently ignored, the installed app falls back
     * to an inset web view, and an iPhone shows a black band above and below
     * the app with the home indicator floating at the bottom of the inset
     * rather than the bottom of the screen.
     *
     * Written out by hand because Next stopped emitting the tag when Apple
     * deprecated it, and Apple never made the replacement work.
     */
    'apple-mobile-web-app-capable': 'yes',
  },
};

/**
 * `viewportFit: 'cover'` lets the frame run under a notched phone's rounded
 * corners; the layout pays for it with `env(safe-area-inset-*)`. Pinch-zoom is
 * deliberately left enabled, because creators zoom in on the caption preview to
 * check placement.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0c0c0c',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      {/*
        Browser extensions (Grammarly and friends) add attributes to <body>
        before React hydrates, which React otherwise reports as a mismatch on
        every page load. Suppressing here covers only <body>'s own attributes.
      */}
      <body suppressHydrationWarning>
        <NoiseFilter />
        <ClerkProvider>{children}</ClerkProvider>
        <Analytics />
      </body>
    </html>
  );
}
