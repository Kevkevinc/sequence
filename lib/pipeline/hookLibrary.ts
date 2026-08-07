/**
 * Reference hook styles the director adapts (never copies verbatim) into the
 * on-screen opening line of each variation.
 *
 * Deliberately no `[product]`/`[item]` bracket placeholder anywhere in this
 * file. A literal fill-in-the-blank token invites literal fill-in-the-blank
 * behavior: the model was observed substituting the job's raw productName
 * text directly into `[item]`, which produced a nonsense hook when that
 * name was not phrase-shaped ("...the voiceover reset everyone is talking
 * about").
 *
 * `[item]` is now used deliberately, with the failure designed out rather than
 * avoided. The director prompt states exactly what to put there: the shortest
 * natural noun for the product, normally one word -- "zip-up", not "Black
 * Streetwear Zip-up" -- which is what makes the substitution read as a person
 * talking instead of a retail title. {@link hooksWithoutItemSlot} drops these
 * lines entirely when there is no product name to put in them.
 *
 * `[price]` lines and lines naming a specific garment (`[hoodie]`, `[jorts]`)
 * are not carried: we do not know the price, and a hook hard-coded to a hoodie
 * is wrong on everything else.
 */

/** Who a line reads as being written by, judged on register rather than topic. */
export type HookAudience = 'mens' | 'womens' | 'any';

export type Hook = { text: string; audience: HookAudience };

const mens = (...lines: string[]): Hook[] => lines.map((text) => ({ text, audience: 'mens' }));
const neutral = (...lines: string[]): Hook[] => lines.map((text) => ({ text, audience: 'any' }));
const womens = (...lines: string[]): Hook[] => lines.map((text) => ({ text, audience: 'womens' }));

/* --------------------------------------------------------- men's groups --- */
/*
 * Grouped by what the line is *about*, because styles draw different groups:
 * a price-comparison style wants VALUE, a fit-focused one wants FIT. Kept as
 * named exports so a style's library is assembled from these rather than
 * copy-pasted, which is how the same hook ended up in three places before.
 */

export const MENS_FIT = mens(
  'the fit on this >',
  'this fit is insane',
  'holy fit',
  'crazy fits >',
  'clean fit >',
  'this fit >>',
  'the fit is actually crazy',
  'this fit though…',
  "tell me this fit isn't clean",
  'this might be my cleanest fit',
  'the way this fits >',
  'the silhouette on this >',
  'the fit is everything',
  'nah this fit is crazy',
  'this might be the one',
  'actually obsessed with this fit',
  'instant fit upgrade',
  'this changed the whole fit',
  'one piece changed the whole outfit'
);

export const MENS_PRODUCT = mens(
  'my new fav [item]',
  'crazy [item]',
  'clean [item]',
  'this [item] >',
  'new [item] unlocked',
  'found my new [item]',
  'this [item] goes crazy',
  'the [item] on this >',
  'these might be my new fav',
  'these are actually so clean',
  'okay these are tough',
  'nah these are hard',
  'these are a NEED',
  'instant cop',
  'adding this to the rotation',
  'this is staying in the rotation'
);

export const MENS_PICKUP = mens(
  'new pickups >',
  "today's pickups",
  'new addition to the wardrobe',
  'just got these in',
  'just found my new favorite',
  'found these and had to cop',
  'new wardrobe addition',
  'adding these to the rotation',
  'my latest pickup',
  'new pickup goes crazy',
  'just discovered these',
  'been looking for something like this',
  'probably my best pickup lately',
  'sleeper pickup',
  'lowkey a crazy pickup',
  'found a crazy [item]',
  'finally found the perfect [item]'
);

export const MENS_VALUE = mens(
  'these for HOW much?',
  'no way these are this cheap',
  "affordable but doesn't look cheap",
  'crazy cheap [item]',
  '[item] this cheap should NOT look this good',
  "best [item] i've gotten for the price",
  "if you're looking for cheap [item]…"
);

export const MENS_SEASONAL = mens(
  'cold weather fits >',
  'summer fits >',
  'fall fits >',
  'winter rotation >',
  'these are perfect for fall',
  'summer wardrobe essential',
  'my go-to for colder days',
  'this is gonna be on repeat',
  'everyday fits >',
  'casual fits >',
  'going-out fits >',
  'airport fits >',
  'date night fits >',
  'weekend fits >',
  'gym-to-street fits >',
  "this is what i'm wearing all fall",
  'this is about to be my daily',
  'perfect everyday [item]'
);

export const MENS_CURIOSITY = mens(
  'wait for the fit',
  'you NEED to see these',
  'why does this fit so well',
  'nah, they cooked with these',
  'they did NOT miss with these',
  'whoever designed these knew what they were doing',
  "i've been gatekeeping these",
  "this one's a sleeper",
  "you're gonna want these",
  'adding this to your cart immediately'
);

/** The very short overlay style, closest to what the reference videos use. */
export const MENS_SHORT = mens(
  'the fit on these >',
  'the wash on these >',
  'the details on this >',
  'the material on this >',
  'the color on these >',
  'the oversized fit >',
  'the baggy fit >',
  'the layering on this >',
  'these hit different',
  'this one is tough',
  'actually so clean',
  'crazy quality',
  'crazy fit',
  'crazy piece',
  'clean pickup',
  'new rotation',
  'new wardrobe staple',
  'easy cop',
  'daily uniform',
  'wardrobe upgrade',
  'fit upgrade',
  'sleeper piece',
  '[item] of the summer'
);

/* ------------------------------------------------------------- neutral --- */
/*
 * Lines with no coded cadence *and* no clothing assumption. Custom mode can be
 * pointed at any product category, so a hook about "the fit" would be nonsense
 * on a candle — these are the ones that survive that.
 */
export const NEUTRAL_HOOKS = neutral(
  'okay hear me out…',
  'just trust me on this',
  "i wasn't expecting this",
  "i wasn't expecting these to be this good",
  "didn't think i'd like these this much",
  'wasn’t expecting the quality to be this good',
  'how is this actually this good',
  "don't sleep on these",
  'hidden gem',
  'absolute steal',
  'the quality on this >',
  'the quality for the price >',
  'looks expensive, costs way less',
  'these look way more expensive',
  'easily worth the price',
  'the price on these >',
  'found these for a steal',
  'this was a VERY good purchase',
  'i finally found it',
  'new favorite unlocked',
  'instant favorite',
  'my new go-to',
  'need this',
  'need these',
  'these >>>',
  'this >>>',
  'i get it now',
  'this is so underrated',
  'no notes'
);

/** The coded cadences, kept for the creators they actually fit. */
export const WOMENS_HOOKS = womens(
  'not me buying another one',
  'currently obsessed',
  'no because why is this so good',
  'actually speechless',
  'this is your sign'
);

/**
 * Custom mode's library.
 *
 * Deliberately excludes the clothing-specific men's groups (FIT, SEASONAL,
 * PICKUP): Custom mode is the mode for any product, and "the fit on this >" is
 * meaningless on a kitchen gadget. The clothing styles pull those groups
 * directly.
 */
export const HOOK_LIBRARY: readonly Hook[] = [
  ...NEUTRAL_HOOKS,
  ...MENS_PRODUCT,
  ...MENS_VALUE,
  ...MENS_CURIOSITY,
  ...WOMENS_HOOKS,
];

/**
 * The lines offered to the director for one creator.
 *
 * A creator who has not said who they make for gets the `any` set only: a
 * neutral line never sounds wrong, whereas guessing wrong is exactly the
 * failure this exists to prevent.
 */
export function hooksForAudience(audience: HookAudience): string[] {
  return HOOK_LIBRARY.filter(
    (hook) => hook.audience === 'any' || hook.audience === audience
  ).map((hook) => hook.text);
}

/**
 * Drops the `[item]` lines when there is nothing to fill the slot with.
 *
 * Offering "crazy [item]" with no product name is how the placeholder gets
 * filled with whatever the model has to hand — the original bug. Job creation
 * requires a product name, so this should never fire; it exists so that the
 * guarantee lives next to the placeholder rather than two files away in a
 * validator someone could relax.
 */
export function hooksWithoutItemSlot(hooks: string[]): string[] {
  return hooks.filter((hook) => !hook.includes('[item]'));
}
