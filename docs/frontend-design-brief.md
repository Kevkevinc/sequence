# UGC AI Editor — Frontend Design Brief

For handing to a design tool (Claude Design or similar). This describes what
the app does and what each screen needs to show — not how it should look.
No visual direction (colors, type, layout) is specified on purpose; that's
the design tool's job.

## What this product does

Lets a TikTok creator upload raw phone footage of themselves trying on or
using a product, and get back several AI-edited, ready-to-post vertical
videos. The AI picks the cuts, writes a hook line, and burns in the hook
text (and optionally a "size worn" overlay) — no manual video editing.

**Audience:** TikTok/UGC creators. Assume mobile-first — creators are as
likely to check on their phone as a laptop.

**Current state:** v1 has no audio at all — every video is silent by
design, so the creator can record their own voiceover afterward. This
should probably be stated somewhere in the upload flow so it's not a
surprise (e.g. "your videos come out muted — you add voice after").

## Screens

### 1. Sign in / Sign up
Handled by Clerk (hosted auth), not custom-built. Nothing to design here
beyond what Clerk's components already provide, unless there's a strong
reason to theme them.

### 2. New Video (job creation) — currently `/jobs/new`
A form with:
- **Raw clips**: multi-file upload (the phone footage)
- **Product name**: text (e.g. "Streetwear Zip-Up Hoodie") — also feeds
  into the AI-written hook text, so worth making clear it should be a real
  product name, not a placeholder
- **Show sizing info**: toggle. When on, reveals a "size worn" text field
  (e.g. "M", "runs small") — burns a small overlay onto the video
- **Length**: 15s / 30s / 45s / 60s
- **Mode**: **Custom** vs **Style** (this is the main branching choice)
  - **Custom mode**: creator picks **Pacing** (Slow / Medium / Fast) and
    **Variations** (how many different edits to generate from the same
    footage, e.g. 1-10)
  - **Style mode**: creator picks one of the available **Styles** instead
    of pacing. Each style is a named preset (name + one-line description)
    that bundles cut rhythm, hook tone, and where the sizing overlay sits.
    Currently two styles exist:
    - **Mixed Cuts** — quick cuts mixing b-roll and try-on footage, sizing
      bottom-right
    - **Dupe Flip** — fast declarative cuts, bold caption, sizing
      bottom-left, and an *optional inspiration photo* upload (e.g. a photo
      of the designer item being "duped") that gets composited into the
      video
    Styles come from `GET /api/styles` — the list is dynamic, don't
    hardcode exactly two.
  - Still needs: **Variations** count either way

### 3. Your Videos (job list) — currently `/jobs`
A list of past jobs, each showing: product name, length, pacing/style,
variation count, and status. Statuses: `pending → tagging → planning →
planned → rendering → done` or `failed` at any stage. Each row links to
the job detail page. Needs an empty state ("no videos yet") and a way to
start a new one.

### 4. Video detail (job status + results) — currently `/jobs/[jobId]`
Shows one job's progress and, once ready, its output videos. This page
**polls** while the job is in progress (every 5s) — design for a live-
updating status, not just a static page.

- Header: product name, length/pacing-or-style, variation count, overall
  status
- If the job has a **warning** (non-fatal — e.g. "style config had a
  problem, fell back to defaults"), show it distinctly from an error
- If the job **failed**, show the failure reason
- One row per **variation**, each independently: `pending` (waiting) /
  `rendering` / `done` / `failed`
  - `done`: an inline video player (vertical, 9:16) + a hook text label +
    duration + a download link
  - `failed`: its own failure reason (one variation failing doesn't fail
    the whole job — others still render)

### 5. Profile — currently `/profile`
Height/weight fields, used for AI-generated sizing overlay text
personalization. Minimal — two fields, save.

## Data shapes in play

```
Job: { productName, sizeWorn?, sizingOverlayEnabled, lengthSeconds (15/30/45/60),
       pacing? (slow/medium/fast) | styleId?, variationCount, status, warning?, failureReason? }

Style: { id, name, description, usesInspirationOverlay }

Variation/Render: { variationNumber, hookText, status (pending/rendering/done/failed),
                     durationSeconds?, playbackUrl?, failureReason? }
```

## Out of scope for this brief
- Audio/voiceover editing (future feature, not built yet)
- Auto-posting to TikTok (future feature, not built yet)
- Any visual branding/color/type direction — that's what the design tool is for
