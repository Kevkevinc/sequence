# AI Editing Pipeline — Stage 2 Design Spec

Date: 2026-07-28

## Problem

Stage 1 (Foundation) built the plumbing: a creator can sign up, set a profile, upload raw clips, and create a "job" describing what kind of video they want (product name, length, pacing, variation count, optional sizing overlay). Every job currently sits at `pending` forever — nothing decides what the actual edit should look like.

Stage 2 builds the "brain": given a job's raw clips and settings, decide which moments from which clips go in which order, write the on-screen hook text, and produce that decision N different ways (one per requested variation). Stage 2 stops at that decision — it does not render an actual video file. That's Stage 3.

## Scope

**In scope:**
- Analyzing each raw clip to find usable moments ("segments") worth including.
- Given the segment pool + job settings, producing N structurally distinct **EditPlans** (one per variation) — the ordered list of segments, hook text, and sizing-overlay text/placement.
- A background worker process that picks up jobs and runs them through this pipeline.
- Error handling for AI/clip failures.

**Explicitly out of scope (deferred):**
- **Reference-video style transfer** (upload a video you like, copy its editing pattern) — proposed during this brainstorm, deliberately deferred to a later phase ("Stage 2.5") rather than built now, to avoid re-architecting the director step twice. Revisit once Stage 2's default hook-library-driven approach is proven.
- Actual video rendering (Stage 3).
- Any UI for reviewing/editing an EditPlan before rendering (later, "lightweight manual editing" phase from the original V1 spec).

## Core workflow

1. A background **worker process** polls the database for jobs in `pending` status, claims one, and moves it to `tagging`.
2. **Tagging step**: for each raw clip in the job, one Gemini API call analyzes that clip and returns a list of candidate segments. Every clip always yields at least one candidate — the whole clip, untrimmed — plus additional sub-segments (with their own start/end times) if the clip is long enough to contain multiple distinct good moments. Each candidate segment is tagged for content type (e.g. b-roll vs. try-on/wearing) and a rough quality/energy signal. If a clip's analysis fails (corrupt file, API error), that clip is skipped and flagged — the job continues with whatever clips succeeded.
3. Once tagging finishes for all clips (or fails for all of them), the job moves to `planning`.
4. **Director step**: one Gemini call receives the full segment pool, the product name, target length, pacing preset, requested variation count, and a built-in reference library of proven UGC hook styles (e.g. "POV:", "things I wish I knew before...", question hooks). It returns all N variations in a single structured response. Each variation is an ordered sequence of segments (by raw-clip + start/end time) whose durations sum to roughly the target length given the pacing preset, a hook line adapted to the product from the style library, and sizing-overlay text/placement if the job has that enabled.
   - If there aren't enough distinct good segments to fill the target length, the director may reuse a segment more than once in the same variation — but never in two consecutive positions; at least one different segment must separate any repeat.
   - The response is validated against a strict schema before being trusted: correct fields, segment references that actually exist in the tagged pool, and each variation's total duration within ±15% of the target length. An invalid response gets fed back to the model for up to two correction attempts before the job is marked `failed`.
5. Each validated variation is saved as its own row. The job moves to `planned`.
6. If tagging fails for every clip, or the director step never produces a valid result within its retry budget, the job moves to `failed` with a plain-language reason.

## Architecture

```
Worker process (separate long-running Node script, e.g. `npm run worker`)
 ├─ Polls `jobs` for status = 'pending', claims one (status -> 'tagging')
 ├─ Tagging: one Gemini call per raw_clip -> candidate segments -> `segments` table
 │    (per-clip failure is caught and flagged; doesn't fail the whole job)
 ├─ Planning: one Gemini call (segment pool + job settings + hook-style library)
 │    -> N EditPlans, schema-validated (retry up to 2x on invalid output)
 │    -> `edit_plans` table, job status -> 'planned'
 └─ Failure paths -> job status 'failed' with a stored reason

Data (Supabase Postgres, additions to Stage 1's schema)
 segments   (id, raw_clip_id, start_seconds, end_seconds, content_tag, quality_tag)
 edit_plans (id, job_id, variation_number, segments: jsonb ordered list of
             {raw_clip_id, start_seconds, end_seconds}, hook_text, sizing_overlay_text,
             sizing_overlay_placement, created_at)

 jobs.status enum extended: 'pending' | 'tagging' | 'planning' | 'planned' | 'failed'
 jobs.failure_reason (text, nullable) — set when status = 'failed'
```

The hook-style reference library is a static list of example hook templates embedded in the director step's prompt/instructions — not a database table, not editable through the app in V1. Cheap to expand later; no reason to over-engineer it now.

**Why a separate worker process instead of doing this inline in the job-creation request:** tagging + directing involves multiple AI calls that can take longer than a web request should reasonably block on. A worker that continuously checks for new work sidesteps that, at the cost of needing an always-on process rather than a purely on-demand one. During development this just runs as a second local process. Production hosting for this worker (something that stays running, unlike typical serverless functions) is a decision for when we actually deploy — not blocking for this stage.

## AI provider

**Gemini** (Google) for both steps:
- Tagging: Gemini accepts video directly, so no separate frame-extraction pipeline is needed — send the clip, get back timestamped segments and tags.
- Directing: Gemini is also used for the planning/reasoning step that produces the EditPlans, keeping this stage to one provider/API key to manage.

Credentials: `GEMINI_API_KEY`, already provisioned and verified against the real API for this build.

## Error handling (plain terms)

- A clip that fails analysis doesn't fail the job — it's skipped and flagged, and the job proceeds with the clips that did work.
- If literally every clip fails, or the director can't produce something usable, the job fails with a clear, specific reason — never silently stuck.
- The AI's output for the director step is checked against strict rules before being trusted (real clips, real timestamps, lengths that make sense) — bad output gets a couple of automatic correction attempts before giving up.

## Testing plan (free)

Gemini's free API tier comfortably covers testing at our current volume (you and your friend), so — same as Stage 1 — building and testing this costs nothing. Since there's no rendered video yet to look at, "it works" is verified by: creating a job, letting the worker process it, and inspecting the resulting `edit_plans` rows directly (I'll translate them into plain English — "variation 1 uses clip A's first 4 seconds, then clip C whole, then clip A again, then clip D, with hook text: ...") so the actual editing decisions can be judged before any rendering effort is spent.

## Open questions carried forward

- Reference-video style transfer — deferred, needs its own brainstorming pass later (see Scope above).
- Exact content of the hook-style reference library (how many templates, which styles) — an implementation detail to flesh out during the build, not a design-level decision.
- Where the worker process will actually run in production (needs an always-on host, not classic serverless) — to be decided at deploy time, not blocking this stage.
