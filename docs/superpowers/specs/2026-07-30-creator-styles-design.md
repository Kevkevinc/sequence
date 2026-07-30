# Creator Styles Design

## Goal

Today, creating a video means manually picking pacing, length, and variation count. This adds a second path: a gallery of pre-built **style cards**. Picking one applies a whole bundled editing recipe — cut rhythm, hook tone, text look, clip ordering, and optional pop-up inspiration photos — with nothing left to configure.

The two paths are explicit, separate modes:

- **Custom mode** — today's flow, unchanged, just relabeled.
- **Style mode** — pick a card from a gallery; no pacing dropdown, no manual tuning.

This is v1 of a system that will later grow a paid feature: a creator uploads any UGC video and the AI analyzes it to save as their own custom style. Nothing in this design blocks that — new styles are just new rows — but building the upload-and-analyze pipeline itself is explicitly out of scope here.

## Two example styles, derived from real reference video

The creator supplied 3 real reference videos per style. Watching them (frame sampling + scene-cut detection) directly shaped this design rather than an assumed table of parameters:

**Style 1 — "Single-Shot Try-On"** (hoodie/sweats examples): one continuous take, no cuts. Plain centered white caption with black outline in the upper third. Sizing overlay bottom-right. No clip ordering (nothing to order — one clip). No overlay photo.

**Style 2 — "Dupe Flip"** (denim examples): multiple cuts. Opens on flat-lay/product-detail b-roll, then cuts to on-body try-on footage later. Bold caption, upper third. Sizing overlay bottom-left. Two of the three examples pop up a small inset image (an outfit-inspo collage in one, a "shop this dupe" product card in another) over the opening few seconds — both clearly the creator's own screenshots/photos, not anything auto-generated or searched. This directly answers the open question from earlier: no built-in image search is being built, and none of the real examples use one — manual upload is not just the safer choice on licensing grounds, it's the actual real-world pattern.

## Data model

```
styles
  id            uuid PK
  creatorId     uuid NULL, references creators   -- null = built-in/system style; filled in later for the paid custom-style feature
  name          text NOT NULL
  description   text NOT NULL                    -- shown on the style card
  config        jsonb NOT NULL                    -- see "Style config" below
  createdAt     timestamp

jobs
  ...unchanged...
  pacing        pacingEnum, NOW NULLABLE           -- set only in Custom mode
  styleId       uuid NULL, references styles       -- set only in Style mode
  -- exactly one of {pacing, styleId} is set; enforced in the job-creation API's validation, not a DB constraint

jobInspirationImages
  id            uuid PK
  jobId         uuid NOT NULL, references jobs
  storageKey    text NOT NULL                      -- same R2 upload pattern as rawClips
  createdAt     timestamp
```

`styles.config` is a flexible blob rather than one column per technique, so a new technique later (something beyond the five below) is a new key plus the code to act on it — not a schema migration. Each known key is still hand-interpreted code, not a generic rules engine.

### Style config shape

```ts
type StyleConfig = {
  cutMinSeconds: number;
  cutMaxSeconds: number;
  hookStyleLibrary: string[];        // replaces the single global HOOK_STYLE_LIBRARY for jobs using this style
  hookPosition?: 'top-center';       // reserved for future values; both v1 styles use the existing fixed layout
  textColor?: string;                // hex; unset = today's default (white fill, black outline)
  sizingPlacement?: OverlayPlacement; // pins sizing text to one corner for every variation of this style, instead of letting the director pick freely
  variesClipOrder: boolean;           // see "Clip ordering" below
  usesInspirationOverlay: boolean;    // see "Inspiration photo overlay" below
};
```

Custom mode does not go through this type at all — it keeps reading `job.pacing` and the existing global `HOOK_STYLE_LIBRARY`, exactly as today. Style mode jobs read everything from `styles.config` via `job.styleId`, resolved live at plan time (no config snapshot onto the job — with only two hand-authored styles today, editing a style and immediately affecting any in-flight job is acceptable simplicity; this can be revisited if/when styles are created and edited by end users through the future paid feature).

### The two v1 styles' actual config values

```
Style 1 — Single-Shot Try-On:
  cutMinSeconds: 15, cutMaxSeconds: 45   (effectively "don't force cuts")
  hookStyleLibrary: [casual, lowercase-friendly lines, e.g. "toughest [item] yet", "new fav [item]"]
  textColor: unset (default)
  sizingPlacement: 'bottom-right'
  variesClipOrder: false
  usesInspirationOverlay: false

Style 2 — Dupe Flip:
  cutMinSeconds: 2, cutMaxSeconds: 5
  hookStyleLibrary: [bold declarative lines, e.g. "Affordable Designer Alternatives..", "How To Dress As A [X]..", "[Item] Under $100"]
  textColor: unset (default)
  sizingPlacement: 'bottom-left'
  variesClipOrder: true
  usesInspirationOverlay: true
```

## Clip ordering: varies *across* variations, not fixed per style

Initial framing was wrong: a style doesn't pin one fixed order ("always b-roll before try-on"). A single style's variations should mix it up — some b-roll-first, some try-on-first, some with no ordering constraint at all — the same way variations already get different hook text and different cut points, so a batch doesn't just feel like one edit five times.

When `variesClipOrder` is true, the director assigns each variation one of three ordering patterns, cycling through them by variation index:

1. **b-roll-first** — all segments tagged `b-roll` appear before any segment tagged `try-on`.
2. **try-on-first** — the reverse.
3. **mixed** — no ordering constraint (today's free behavior).

Segments tagged `whole-clip` or `other` are unconstrained by this rule and can land anywhere — the constraint only applies between the `b-roll` and `try-on` groups. This slots into the director prompt right next to the existing distinctness instruction ("THE N VARIATIONS MUST BE STRUCTURALLY DIFFERENT EDITS...") as one more axis of required difference, and is enforced the same way other structural rules are: stated in the prompt and checked by the Zod validator.

If a job's tagged footage doesn't actually contain both a `b-roll` and a `try-on` segment, the ordering instruction is skipped for that job — same graceful-degradation approach already used when footage can't fill the requested length.

`variesClipOrder: false` (Style 1, and Custom mode) means exactly what it does today: no ordering instruction at all.

## Inspiration photo overlay

Scope for v1: **one** inspiration photo per job, for styles with `usesInspirationOverlay: true`. The Style-mode job form conditionally shows an upload field when such a style is selected. The photo is stored via the same presigned-R2-upload flow as raw clips, in the new `jobInspirationImages` table (built as a table rather than a single column so a later "multiple photos / collage" enhancement is new rows, not a new migration).

Rendering: composited as a bordered thumbnail image in the upper-left, visible for the video's first ~4 seconds (alongside the hook window) — this matches where both real examples placed it. Mechanically this extends the existing `overlayText` PNG-layer-plus-`enable=window` approach in `lib/render/text.ts`: today it composites canvas-drawn text layers; this adds one more layer type (a decoded uploaded image, resized into a fixed thumbnail frame) into the same `overlay` filter chain. No new ffmpeg approach is needed.

Deliberately NOT in v1 (matches the creator's "Just those, for now" scope): multi-photo collages, the price-comparison-card visual treatment from the second reference video, and any auto-sourcing (search, AI-generation) of the image.

## Job creation UI

- Entry point forks into **"Custom"** and **"Style"**.
- Custom: today's form, unchanged except the label.
- Style: a gallery of cards (name + description text for v1 — thumbnail previews are a future nice-to-have, not built now, since there's no thumbnail-generation pipeline yet). Selecting a card removes the pacing field entirely. If the selected style has `usesInspirationOverlay: true`, an upload field for one inspiration photo appears.
- Both modes keep length, product name, sizing toggle/size-worn, variation count, and raw clip upload exactly as they work today.

## Not in scope for this design

- The paid "AI analyzes an uploaded video to create a custom style" feature — only the extensibility for it (nullable `creatorId`).
- Auto-sourcing inspiration images from the web.
- Style thumbnail/preview generation.
- Any technique beyond the five above (cut rhythm, hook tone, text color, clip-order variation, inspiration overlay).
