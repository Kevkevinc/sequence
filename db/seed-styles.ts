import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { styles } from '@/db/schema';
import type { StyleConfig } from '@/lib/styles';

/**
 * The two v1 styles, hand-authored from real reference video (frame sampling
 * plus ffmpeg scene-cut detection on 3 example clips per style — see
 * docs/superpowers/specs/2026-07-30-creator-styles-design.md). Cut rhythm and
 * sizing placement come directly from that footage; each `hookStyleLibrary`
 * captures the tone/format the reference clips demonstrated (casual lowercase
 * vs. bold declarative) plus other patterns known to perform well in that same
 * format — not verbatim transcriptions of the reference clips' own captions.
 */
const BUILT_IN_STYLES: { name: string; description: string; config: StyleConfig }[] = [
  {
    name: 'Mixed Cuts',
    description:
      "Quick cuts mixing b-roll and try-on footage, muted so the creator can add their own voiceover, sizing in the bottom-right.",
    config: {
      // Medium-speed cut band, per creator direction: 2.5-4s.
      cutMinSeconds: 2.5,
      cutMaxSeconds: 4,
      // Patterns proven on TikTok in this casual/lowercase format, not
      // verbatim lines from the reference clips.
      hookStyleLibrary: [
        'new fav [item]',
        'toughest [item] yet',
        'this [item] hits different',
        'okay this [item] might be my favorite',
        'wait til you see this [item]',
        "not me buying another [item]",
        "the [item] i've been living in lately",
        'y\'all weren\'t lying about this [item]',
        'pov: you just found the [item] everyone is talking about',
        'okay hear me out on this [item]',
      ],
      sizingPlacement: 'bottom-right',
      variesClipOrder: false,
      usesInspirationOverlay: false,
    },
  },
  {
    name: 'Dupe Flip',
    description: 'Fast-cut b-roll into try-on, bold caption, sizing bottom-left, optional inspiration photo.',
    config: {
      cutMinSeconds: 2,
      cutMaxSeconds: 5,
      // Patterns proven on TikTok in this bold declarative dupe/price-comparison
      // format, not verbatim lines from the reference clips.
      hookStyleLibrary: [
        'Affordable Designer Alternatives..',
        'How To Dress As A [X]..',
        '[Item] Under $100',
        '[Item] Dupes You Need To Know About',
        'Get The Look For Less..',
        'Stop Overpaying For [Item]',
        '[Item] That Looks Way More Expensive Than It Is',
        'POV: You Found The Dupe',
        'How To Dress Like You Have Money..',
        '[Brand] Alternative For A Fraction Of The Price',
      ],
      sizingPlacement: 'bottom-left',
      variesClipOrder: true,
      usesInspirationOverlay: true,
    },
  },
];

/** Idempotent: safe to run against a fresh database or one that already has these rows. */
export async function seedBuiltInStyles(): Promise<void> {
  for (const style of BUILT_IN_STYLES) {
    const existing = await db.query.styles.findFirst({ where: eq(styles.name, style.name) });
    if (existing) continue;
    await db.insert(styles).values(style);
  }
}

// Run directly via `npm run seed:styles`; not imported by the app at runtime.
if (require.main === module) {
  seedBuiltInStyles()
    .then(() => {
      console.log('Seeded built-in styles.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Failed to seed built-in styles:', error);
      process.exit(1);
    });
}
