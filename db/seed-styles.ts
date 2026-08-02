import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { styles } from '@/db/schema';
import type { StyleConfig } from '@/lib/styles';

/**
 * The two v1 styles, hand-authored from real reference video (frame sampling
 * plus ffmpeg scene-cut detection on 3 example clips per style — see
 * docs/superpowers/specs/2026-07-30-creator-styles-design.md). Cut rhythm and
 * sizing placement come directly from that footage.
 *
 * Each `hookStyleLibrary` blends 2026 TikTok Shop UGC/affiliate hook research
 * (curiosity, POV, social proof, outcome-first, bold declarative for
 * dupe/price content) with real examples the creator supplied directly from
 * what's currently converting for them — short, understated "genuine
 * reaction" lines outperform obvious ad-copy hooks ("you need this") because
 * they read as organic content rather than sponsored. Not verbatim
 * transcriptions of the reference clips' own captions.
 *
 * None of these contain a `[product]`/`[item]`/`[X]`/`[Brand]` bracket
 * placeholder. The director's prompt tells the model to adapt these, not
 * substitute into them, but a literal bracket token invited literal
 * fill-in-the-blank behavior anyway — observed producing a nonsense hook
 * when a job's raw productName wasn't phrase-shaped. Complete natural
 * sentences give the model tone and rhythm to imitate instead of a slot to
 * paste into; see lib/pipeline/hookLibrary.ts's docstring for the same fix
 * applied to Custom mode's default library.
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
      // Short, understated "genuine reaction" lines rather than ad-copy —
      // per creator direction, this register consistently outperforms
      // obvious hooks like "you need this" because it blends into organic
      // TikTok content instead of reading as sponsored.
      hookStyleLibrary: [
        'okay these kinda ate',
        "wasn't expecting this quality",
        'the fit is actually crazy',
        'why does this feel so expensive',
        "i'm keeping this",
        'one of the best pickups this year',
        'never taking this off',
        'obsessed.',
        'this is your sign',
        'not me buying another one',
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
      // Price-shock/declarative, per creator direction: short punchy price
      // callouts mixed with the dupe genre's established bold statements.
      hookStyleLibrary: [
        'crazy cheap',
        'expensive looking >>',
        'these look way more expensive',
        '$20?? no way',
        'why are these so good??',
        'get the look for less..',
        "the dupe you didn't know you needed",
        'how to dress like you have money..',
        'under $50 and nobody can tell the difference',
        "found the dupe everyone's been asking about",
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
