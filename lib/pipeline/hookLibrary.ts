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
export const HOOK_STYLE_LIBRARY = [
  'wait...',
  'okay hear me out',
  "i wasn't expecting this",
  'this is your sign',
  'not me buying another one',
  'currently obsessed',
  'no because why is this so good',
  'actually speechless',
  'i get it now',
  'this is so underrated',
] as const;
