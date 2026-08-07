import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { styles } from '@/db/schema';
import type { StyleConfig } from '@/lib/styles';
import {
  MENS_CURIOSITY,
  MENS_FIT,
  MENS_PICKUP,
  MENS_PRODUCT,
  MENS_SEASONAL,
  MENS_SHORT,
  MENS_VALUE,
  type Hook,
} from '@/lib/pipeline/hookLibrary';

/** Style-specific lines, kept beside the style they belong to. */
const MIXED_CUTS_NEUTRAL: Hook[] = [
  { text: "wasn't expecting this quality", audience: 'any' },
  { text: 'why does this feel so expensive', audience: 'any' },
  { text: "i'm keeping this", audience: 'any' },
  { text: 'never taking this off', audience: 'any' },
  { text: 'this is actually worth it', audience: 'any' },
];
const MIXED_CUTS_WOMENS: Hook[] = [
  { text: 'okay these kinda ate', audience: 'womens' },
  { text: 'obsessed.', audience: 'womens' },
  { text: 'this is your sign', audience: 'womens' },
  { text: 'not me buying another one', audience: 'womens' },
];

const DUPE_FLIP_NEUTRAL: Hook[] = [
  { text: 'crazy cheap', audience: 'any' },
  { text: 'expensive looking >>', audience: 'any' },
  { text: 'these look way more expensive', audience: 'any' },
  { text: '$20?? no way', audience: 'any' },
  { text: 'get the look for less..', audience: 'any' },
  { text: "the dupe you didn't know you needed", audience: 'any' },
  { text: 'how to dress like you have money..', audience: 'any' },
  { text: 'under $50 and nobody can tell the difference', audience: 'any' },
];
const DUPE_FLIP_WOMENS: Hook[] = [
  { text: 'why are these so good??', audience: 'womens' },
  { text: "found the dupe everyone's been asking about", audience: 'womens' },
];

const FIT_INSPO_NEUTRAL: Hook[] = [
  { text: 'i found the cheaper version', audience: 'any' },
  { text: 'this is the look i was going for', audience: 'any' },
  { text: 'recreating this fit for way less', audience: 'any' },
  { text: 'same vibe, fraction of the price', audience: 'any' },
  { text: 'this is what i actually bought', audience: 'any' },
  { text: 'how to get this look', audience: 'any' },
];
const FIT_INSPO_MENS: Hook[] = [
  { text: 'how to dress like this without the price tag', audience: 'mens' },
  { text: 'building this fit for under $100', audience: 'mens' },
  { text: 'the fit inspo vs what i got', audience: 'mens' },
];
const FIT_INSPO_WOMENS: Hook[] = [
  { text: 'obsessed with recreating this', audience: 'womens' },
  { text: 'not me copying this exact fit', audience: 'womens' },
];

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
      // Medium-speed cut band, per creator direction: 1.5-4s, on a 30s target.
      cutMinSeconds: 1.5,
      cutMaxSeconds: 4,
      // Short, understated "genuine reaction" lines rather than ad-copy —
      // per creator direction, this register consistently outperforms
      // obvious hooks like "you need this" because it blends into organic
      // TikTok content instead of reading as sponsored.
      //
      // Tagged by the audience each line's *register* sounds native to, not by
      // the product. Per creator direction, a menswear creator captioned in
      // women's-content cadence ("obsessed.", "these kinda ate") reads as
      // someone else's script — so those lines are kept for the creators they
      // fit rather than deleted, and a creator who has not set an audience is
      // only ever offered the neutral ones.
      // Assembled from the shared groups rather than restated: the same hook
      // used to live in three files and drift in all of them.
      hookStyleLibrary: [
        ...FIT_INSPO_NEUTRAL,
        ...MENS_FIT,
        ...MENS_CURIOSITY,
        ...FIT_INSPO_MENS,
        ...FIT_INSPO_WOMENS,
      ],
      sizingPlacement: 'bottom-right',
      variesClipOrder: false,
      usesInspirationOverlay: false,
      usesFitInspoIntro: true,
    },
  },
];

/**
 * Idempotent: safe to run against a fresh database or one that already has
 * these rows.
 *
 * Existing built-ins are *updated* rather than skipped. This file is the source
 * of truth for their cut bands and hook libraries, and skipping meant editing a
 * band here changed nothing: the row kept whatever it was first seeded with,
 * silently, so a retuned preset only applied on a database that had never been
 * seeded. Matched on name, which is what `styles.name` uniquely identifies a
 * built-in by; creator-authored styles are never touched because none of them
 * carry these names.
 */
export async function seedBuiltInStyles(): Promise<void> {
  for (const style of BUILT_IN_STYLES) {
    const existing = await db.query.styles.findFirst({ where: eq(styles.name, style.name) });
    if (existing) {
      await db
        .update(styles)
        .set({ description: style.description, config: style.config })
        .where(eq(styles.id, existing.id));
      continue;
    }
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
