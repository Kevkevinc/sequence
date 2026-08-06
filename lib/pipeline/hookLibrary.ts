/**
 * Reference hook styles the director adapts (never copies verbatim) into the
 * on-screen opening line of each variation.
 *
 * Deliberately no `[product]`/`[item]` bracket placeholder anywhere in this
 * list. A literal fill-in-the-blank token invites literal fill-in-the-blank
 * behavior: the model was observed substituting the job's raw productName
 * text directly into `[item]`, which produced a nonsense hook when that
 * name was not phrase-shaped ("...the voiceover reset everyone is talking
 * about"). These entries are complete, natural sentences instead — short,
 * understated "genuine reaction" lines (per creator direction, this
 * register outperforms obvious ad-copy hooks like "you need this" because it
 * reads as organic content, not sponsored) rather than clothing-specific, so
 * they fit any product category Custom mode might be used for.
 */

/** Who a line reads as being written by, judged on register rather than topic. */
export type HookAudience = 'mens' | 'womens' | 'any';

export type Hook = { text: string; audience: HookAudience };

/**
 * Register, not subject matter.
 *
 * Certain TikTok cadences are strongly coded — "not me buying...", "no because
 * why is this...", "obsessed", "ate" read as women's content, and a menswear
 * creator using them sounds like he is reading someone else's script. That
 * mismatch is what the creator flagged, so each line is tagged with the
 * audience it sounds native to and `any` is reserved for lines that genuinely
 * sit either side.
 *
 * Nothing here is about the product. A hoodie is a hoodie; what changes is the
 * voice the caption is written in.
 */
export const HOOK_LIBRARY: readonly Hook[] = [
  // Neutral: plain reactions with no coded cadence.
  { text: "i wasn't expecting this", audience: 'any' },
  { text: 'i get it now', audience: 'any' },
  { text: 'this is so underrated', audience: 'any' },
  { text: 'okay hear me out', audience: 'any' },
  { text: 'this is actually worth it', audience: 'any' },
  { text: 'better than i expected', audience: 'any' },
  { text: 'no notes', audience: 'any' },
  { text: 'this one is staying', audience: 'any' },

  // Men's: flatter, more understated, no intensifier stacking.
  { text: 'this is actually solid', audience: 'mens' },
  { text: 'one of the best pickups this year', audience: 'mens' },
  { text: 'the fit is actually crazy', audience: 'mens' },
  { text: 'been wearing this nonstop', audience: 'mens' },
  { text: 'this hits different in person', audience: 'mens' },
  { text: 'quality is not what i expected', audience: 'mens' },
  { text: 'my go to now', audience: 'mens' },

  // Women's: the coded cadences, kept for creators they actually fit.
  { text: 'not me buying another one', audience: 'womens' },
  { text: 'currently obsessed', audience: 'womens' },
  { text: 'no because why is this so good', audience: 'womens' },
  { text: 'actually speechless', audience: 'womens' },
  { text: 'this is your sign', audience: 'womens' },
];

/**
 * The lines offered to the director for one creator.
 *
 * A creator who has not said who they make for gets the `any` set only: a
 * neutral line never sounds wrong, whereas guessing wrong is exactly the
 * failure being fixed here.
 */
export function hooksForAudience(audience: HookAudience): string[] {
  return HOOK_LIBRARY.filter(
    (hook) => hook.audience === 'any' || hook.audience === audience
  ).map((hook) => hook.text);
}
