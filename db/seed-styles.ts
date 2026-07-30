import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { styles } from '@/db/schema';
import type { StyleConfig } from '@/lib/styles';

/**
 * The two v1 styles, hand-authored from real reference video (frame sampling
 * plus ffmpeg scene-cut detection on 3 example clips per style — see
 * docs/superpowers/specs/2026-07-30-creator-styles-design.md).
 */
const BUILT_IN_STYLES: { name: string; description: string; config: StyleConfig }[] = [
  {
    name: 'Single-Shot Try-On',
    description: 'One continuous take, casual caption, sizing in the bottom-right.',
    config: {
      cutMinSeconds: 15,
      cutMaxSeconds: 45,
      hookStyleLibrary: [
        'new fav [item]',
        'toughest [item] yet',
        'this [item] hits different',
        'okay this [item] might be my favorite',
        'wait til you see this [item]',
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
      hookStyleLibrary: [
        'Affordable Designer Alternatives..',
        'How To Dress As A [X]..',
        '[Item] Under $100',
        '[Item] Dupes You Need To Know About',
        'Get The Look For Less..',
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
