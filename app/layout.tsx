import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { Bricolage_Grotesque, Manrope, Space_Mono } from 'next/font/google';
import { LiquidGlassDefs } from '@/components/LiquidGlassDefs';
import './globals.css';

const bricolage = Bricolage_Grotesque({
  variable: '--font-bricolage',
  subsets: ['latin'],
  weight: ['600', '700', '800'],
});

const manrope = Manrope({
  variable: '--font-manrope',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
});

const spaceMono = Space_Mono({
  variable: '--font-space-mono',
  subsets: ['latin'],
  weight: ['400', '700'],
});

export const metadata: Metadata = {
  title: 'Cutloop — UGC AI Editor',
  description: 'Upload your raw footage. The AI picks the cuts, writes the hook, and burns it in.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${manrope.variable} ${spaceMono.variable}`}
    >
      {/*
        Browser extensions (Grammarly and friends) add attributes to <body>
        before React hydrates, which React otherwise reports as a mismatch on
        every page load. Suppressing here covers only <body>'s own attributes,
        not any of the app's markup.
      */}
      <body suppressHydrationWarning>
        {/*
          One shared <defs> for the whole app: every .glass panel references the
          filter by id, so defining it per-component would put N copies of the
          same turbulence/displacement graph in the DOM.
        */}
        <LiquidGlassDefs />
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
