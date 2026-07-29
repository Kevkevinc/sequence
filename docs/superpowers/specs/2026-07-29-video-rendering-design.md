# Video Rendering — Stage 3 Design Spec

Date: 2026-07-29

## Problem

Stage 2 produces **EditPlans** — structured descriptions of an edit (ordered cuts by clip + in/out time, hook text, sizing overlay text and placement). They are correct and verified against real footage, but nobody can watch them. Stage 3 turns each EditPlan into a real, downloadable MP4 and shows it to the creator.

This is the stage where the product becomes usable: upload clips → get videos you can post.

## Rendering approach: self-hosted ffmpeg

**Decision: render with ffmpeg on our own worker, not a cloud rendering API.**

The V1 spec (2026-07-27) planned to use Shotstack, on the stated basis that its sandbox offered unlimited free watermarked renders for testing. **That basis was wrong** — Shotstack's sandbox requires credits, and new accounts get 10 credits (~20 videos at 30s) valid for 30 days. Stage 2 required six rounds of live iteration to get right; Stage 3 will need similar, and that allowance would be spent on debugging.

The economics also changed the calculus. Shotstack costs $0.20–0.30 per minute of output. At the target creator's 30 videos/day (~15 minutes), that is **$90–135/month per heavy creator** — roughly 4–6× the Gemini cost, and the single largest cost in the product. It comes directly out of freemium margin.

ffmpeg is free, and what an EditPlan describes (trim ranges, concatenate, overlay two pieces of text) is exactly what ffmpeg does. The binary ships via the `ffmpeg-static` npm package, so there is nothing to install manually. It runs on the worker process that already exists from Stage 2.

**Trade-offs accepted:** text styling takes more work to look right than a template-based API, and rendering consumes our own CPU rather than a render farm. The second becomes a hosting consideration at scale, not a V1 problem.

**Kept open:** the renderer sits behind a single `renderPlan(editPlan) → file` interface. EditPlan was already the contract between planning and rendering, so swapping in a cloud renderer later remains a component swap, not a rewrite.

## Output format

- **1080×1920 (9:16 vertical)**, H.264 video + AAC audio, 30fps, MP4.
- Source clips vary in resolution, framerate, and orientation (iPhone footage carries rotation metadata). Every cut is normalised to the output format before being joined, rather than assuming consistent inputs.
- Original clip audio is preserved. A cut whose source has no audio track gets silent audio generated, so the join does not fail or desync.

## On-screen text

**Hook text** — the attention-grabber. Large bold sans-serif, white with a heavy dark outline/shadow so it stays legible over any footage, positioned in the upper third, on screen for the first 3 seconds. This is the standard short-form UGC look.

**Sizing overlay** — smaller than the hook, same legibility treatment, placed at the corner the director chose (`sizing_overlay_placement`, one of six positions), shown for 3 seconds starting around a third of the way into the video, so it lands while the try-on footage is on screen rather than competing with the hook.

Text is **not** rendered by ffmpeg. Its `drawtext` filter was tested against the bundled ffmpeg 6.1.1 and silently corrupts exactly the text this product generates — truncating at the first colon, dropping apostrophes, offering no word wrap, and falling back to a serif font on Windows. Instead each text block is drawn to a transparent PNG with a real 2D text renderer (`@napi-rs/canvas`), which loads a repo-committed font explicitly and wraps by measuring the actual glyphs, and is then composited onto the video with ffmpeg's `overlay` filter. ffmpeg never sees the text, so there is no escaping surface at all.

## Pipeline

The worker gains a third stage after tagging and directing:

1. Worker claims a job in `planned` status, moves it to `rendering`.
2. For each of the job's EditPlans (one per variation):
   a. Download each referenced source clip to a temp file (reusing Stage 2's `downloadClipToTempFile`).
   b. **Normalise** each cut: trim to its in/out point and re-encode to the common output format, producing one temp file per cut.
   c. **Concatenate** the normalised cuts into a single video.
   d. **Overlay** the hook text and, if present, the sizing overlay.
   e. Upload the finished MP4 to R2 and record it.
3. When every variation has rendered, the job moves to `done`. Temp files are cleaned up whether rendering succeeded or failed.

The normalise → concatenate → overlay split is deliberate. A single monolithic ffmpeg filter graph is faster but fails opaquely on mixed-source footage; three simple passes are debuggable, and each failure points at a specific cut.

**Per-variation failure is isolated.** One variation failing to render does not fail the others — the job completes with the variations that succeeded and records which failed, matching the partial-failure behaviour tagging already has.

## Data

```
renders (id, edit_plan_id, job_id, storage_key, duration_seconds,
         status, failure_reason, created_at)

jobs.status enum grows: … | 'rendering' | 'done'
```

`renders` was already in the V1 spec's data model. `storage_key` points at the finished MP4 in R2, alongside the raw clips.

## Creator-facing UI

The job list gains per-job render status. Opening a job shows its finished variations: each playable in the browser and downloadable, labelled with its hook text so the creator can tell them apart at a glance. A variation that failed to render is shown as failed rather than silently missing.

Videos are served through short-lived presigned R2 URLs — the bucket stays private.

## Out of scope for this stage

- **Credits and billing enforcement.** The V1 spec calls for credit deduction on submit and refund on failure. That is a self-contained concern that does not block watching a video, and bundling it here would widen this stage considerably. It gets its own stage, before any real users.
- **Manual editing UI** (reorder/tweak before export) — unchanged from the V1 spec, still the phase after the automated pipeline is proven.
- **Voiceover editing** — phase 2, unchanged.
- **Reference-video style transfer** — still deferred.
- **Watermarking free-tier output** — belongs with billing, since it only matters once tiers exist.
- **Hosting the worker somewhere always-on.** Rendering on a developer machine is fine for validating quality; production hosting (and the CPU cost of rendering at volume) is a deployment decision, not a V1 blocker.

## How this stage is judged

Not by tests passing — by watching the videos. Success is: the creator's real footage comes back as MP4s that play, are the requested length, cut at the requested pace, carry legible hook and sizing text, and look like plausible UGC ads. That judgement requires human eyes on the output, which is exactly what this stage finally makes possible.

## Known risks

- ~~`drawtext` escaping~~ — **retired as a risk by switching away from `drawtext` entirely** (see On-screen text). It was tested first rather than assumed: the failure was silent corruption of real hooks, not an error, which is the worst shape a bug can take.
- **Rotation metadata** on phone footage can produce sideways output if the normalise step ignores it.
- **Render time** on CPU is meaningful — several seconds to minutes per video depending on length and machine. Acceptable for validation; a factor for scale.
