# UGC AI Editor — V1 Design Spec

Date: 2026-07-27

## Problem

TikTok UGC creators who film raw product clips (e.g. try-on/wearing footage, b-roll) spend most of their time manually editing that footage into the fast-cut, hook-driven, ad-style format that converts — constant clip changes (every 1-6s depending on style), an on-screen text hook at the start, and on-screen sizing info later in clothing videos. One creator (the target early user) aims for ~30 uploads/day; editing is the bottleneck, not filming.

Separately, uploading many videos per day runs into TikTok's duplicate-content throttling. Creators want many genuinely distinct edits from the same raw footage, not just one polished video.

## Market context (research summary)

- **CutAI** (usecutai.com) is the named competitor. It's real but still private-beta/waitlist, targeting TikTok Shop sellers. Its public workflow is: upload raw footage → auto-cut silences/false starts/retakes → score takes by energy/conviction/pacing → deliver one finished video. Nothing publicly documented shows text-hook overlays or multi-variant generation — that combination looks like open territory, not something to assume is already solved elsewhere.
- Adjacent tools (Opus Clip, Klap, Munch — long-form repurposing; Creatify, Arcads — generative ad creation from scripts) don't do raw-clip UGC editing with structural multi-variant export. A separate, disreputable corner of "video uniquifier" tools does pixel/metadata fuzzing without real AI editing.
- Freemium in this category is almost universally **credit-based** (per-video/per-minute), not flat subscriptions, because compute cost scales with usage.
- TikTok's duplicate detection is reportedly multi-layered: perceptual video hashing, audio fingerprinting, metadata/C2PA tracking, and behavioral pattern detection (posting cadence, repeated captions). Structural variation (reorder/retrim/different segments/different hook) addresses only one layer. **Product positioning decision: market this as "generate multiple distinct creative cuts fast," not as an explicit TikTok-detection bypass tool.** Pixel/audio-level hardening (crop/speed/color/re-encode variation) is deliberately deferred past V1 — see Out of Scope.

## V1 Scope

### User & account model
- Individual creator accounts (not agency/multi-brand) — one person, their own clips, their own jobs.
- Creator profile stores height and weight (set once, editable), used for sizing overlays.

### Core workflow
1. Creator uploads raw clips (e.g. 4 clips, ~20s each — mix of b-roll and try-on footage) for one video job.
2. Creator provides, per job: product name (free text, AI infers everything else from it — no structured product-fact form in V1), optional "size worn" (only relevant if sizing overlay is on), a sizing-overlay on/off toggle (manual — not auto-detected from clips), target video length (preset: 15/30/45/60s, default 30s), pacing preset (Slow ~5-6s/clip, Medium ~3-4s/clip, Fast ~1-2s/clip), and desired variation count (user-configurable, credit-gated).
3. **Segment-level tagging**: the app analyzes each raw clip and identifies multiple candidate sub-segments within it (not just the whole clip) — e.g. from one 20s raw clip it might flag a good moment at 10s-14s and a separate good moment at 16s-19s, each tagged for content/energy/try-on relevance. A segment is a reference (raw clip id + start time + end time), not a copy — the same or overlapping footage can be selected by multiple variations.
4. **AI director step**: given the tagged segment pool, product name, chosen length, and pacing, an LLM produces a structured **EditPlan** — an ordered list of segments (each a raw-clip + in/out time), the on-screen hook text (drawn from a library of proven UGC hook styles/archetypes, e.g. "POV:", "things I wish I knew before...", question hooks), and the sizing overlay text/placement if enabled.
5. **Variation generation**: from the base EditPlan, N variant EditPlans are derived — different segment selection, ordering, and/or hook variant — each still honoring the chosen length and pacing.
6. **Rendering**: each EditPlan is submitted to a cloud video-rendering API as a JSON composition and rendered into a finished video file.
7. Creator sees job progress and, on completion, a gallery of N finished videos to download.

### Error handling (plain terms)
- A clip that fails to process (corrupt, too short, unreadable) surfaces a plain-language error identifying that clip, without failing the whole job if other clips are fine.
- A failed render does not consume credits; the creator can retry without re-uploading.
- Job status is always visible (queued / processing / done / failed) — no silent failures.

### Monetization
- Credits-based freemium. 1 credit ≈ 1 rendered video (main edit or one variation), up to the selected length.
- Free tier: small monthly credit allowance, watermarked output.
- Paid tiers: larger monthly credit bundles, no watermark, higher per-job variation caps; extra credits purchasable a-la-carte.
- Stripe integration built from the start but left in test mode during the two-person free-testing phase (see MVP Testing Plan).

### Platform
- Responsive webapp only (works in desktop and mobile browsers). No native mobile app in V1.

## Architecture

```
Webapp (Next.js)
 ├─ Auth (Clerk)
 ├─ Creator profile (height/weight)
 ├─ Job creation UI (upload clips, product name, size-worn field [only shown/required
 │    when sizing toggle is on], sizing toggle, length preset, pacing preset, variation count)
 ├─ Job status / gallery (progress + download finished variations)
 └─ Credits/billing UI (Stripe — test mode during free-testing phase)

Backend (Next.js API routes + Postgres-backed job queue — no separate Redis needed)
 ├─ Upload handler → object storage (Cloudflare R2)
 ├─ Tagging worker: Whisper transcription + vision-model pass per raw clip
 │    → candidate segments (raw_clip_id, start, end) with content/energy/try-on tags
 ├─ Director worker (LLM): segments + product name + hook-archetype library +
 │    length/pacing params → EditPlan (JSON: ordered segments, hook text, sizing overlay)
 ├─ Variation worker: base EditPlan → N variant EditPlans (different segments/order/hook)
 ├─ Render worker: EditPlan → cloud rendering API call → poll/webhook → store output
 └─ Credit ledger: deduct on submit, refund on render failure

Data (Supabase Postgres)
 creators | jobs | edit_plans | raw_clips | segments | renders | credit_ledger

(product name is just a text field on `jobs` — no separate product-profile entity,
per the V1 decision to keep product input fully freeform, no reusable profiles.)
```

**EditPlan JSON is the key internal contract** between the AI-planning stage and the renderer — the render worker only ever consumes an EditPlan, so the underlying rendering technology can change without touching the AI pipeline.

### Rendering approach
Cloud video-rendering API (Shotstack) for V1 — no render infrastructure to build/operate, ships fastest, cost is per-minute-rendered (feeds directly into credit pricing). A self-hosted renderer (Remotion on serverless) remains a future option once volume makes API cost the dominant line item; because EditPlan is a clean abstraction, that would be a component swap, not a rewrite. Raw ffmpeg is noted as a theoretical lowest-cost/highest-effort option, not planned for V1 or V2.

### MVP testing plan (free for creator + friend)
- Shotstack's free **sandbox** stage (unlimited renders, watermarked, not for production) is used for all testing — real rendering quality, no cost.
- LLM/vision-tagging calls at two-person testing volume are near-zero cost.
- Credits are manually granted to test accounts rather than wiring real Stripe charges.
- Flipping to production rendering (paid, unwatermarked) and live billing later is a configuration change.

## Out of scope for V1 (deliberately deferred)

- **Lightweight manual editing UI** (reorder/tweak an AI-generated edit before export) — planned as the immediate next phase after V1 ships; V1 is fully automated end-to-end.
- **Voiceover editing** (remove pauses/filler words, pick best take among repeated line readings from uploaded/recorded raw audio) — phase 2. Research note: filler-word/silence removal is a solved problem (Descript ships this; WhisperX + silence detection is the realistic DIY stack); "best take of repeated lines" is not commoditized and would need custom comparison logic — worth its own design pass when this phase starts.
- **Pixel/audio-level anti-detection hardening** (crop/speed/color shifts, re-encoding, audio pitch-shift to defeat more of TikTok's detection layers) — only pursued if V1's structural variation proves insufficient in practice.
- **Agency/multi-brand accounts** — V1 is individual-creator only.
- **Native mobile app** — responsive webapp covers phone browser use for V1.

## Open questions for later phases

- Exact credit pricing/tier thresholds — needs real cost data from V1 usage before finalizing.
- Whether variation generation should eventually also vary hook *style* (not just wording) per variant.
- Whether TikTok's detection posture changes enough over time to warrant the deferred pixel/audio hardening sooner.
