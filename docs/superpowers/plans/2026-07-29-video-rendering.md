# Video Rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each Stage 2 EditPlan into a real, watchable 9:16 MP4 with hook and sizing text burned in, stored in R2 and playable from the job page.

**Architecture:** ffmpeg (binary supplied by `ffmpeg-static`, nothing to install) runs on the existing worker. Each variation renders in three debuggable passes — normalise every cut to a common format, concatenate them, then overlay text — behind a single `renderPlan()` interface so a cloud renderer could replace it later.

**Tech Stack:** `ffmpeg-static`, Node `child_process.execFile`, existing Drizzle/Postgres/R2/Next.js stack.

## Global Constraints

- All server-side env vars go through `getRequiredEnv()` / `getEnvWithDefault()` — never `process.env.X` directly.
- Output format is fixed: **1080×1920, H.264 + AAC, 30fps, MP4**.
- **Never build ffmpeg commands as shell strings.** Use `execFile` with an argument array, so filenames and text never need shell quoting. This is the single biggest source of cross-platform breakage.
- **Never inline model-authored text into a filter string.** Hook text comes from an LLM and will eventually contain apostrophes, colons, commas and quotes — all of which are `drawtext` metacharacters. Use `drawtext=textfile=...` pointing at a temp file instead.
- Every temp file created must be removed on both success and failure paths.
- `renderPlan` and its callers follow the established `{ success: true, ... } | { success: false, error: string }` contract and never throw — the worker depends on this.
- Per-variation failure is isolated: one variation failing must not fail the others, matching tagging's partial-failure behaviour.
- No hardcoded secrets, ever. This project had a real credential-leak incident.
- Tests touching the database run against the real dev Supabase project (existing convention).
- ffmpeg is **not** mocked in the renderer's own tests — rendering tiny synthetic clips is fast and a mocked ffmpeg would prove nothing. Generate fixtures with ffmpeg itself (`testsrc`/`sine`).

---

## Task 1: Schema — renders table and render job statuses

**Files:**
- Modify: `db/schema.ts`
- Test: `tests/db/schema.test.ts` (extend)

**Interfaces:**
- Produces: `renders` table; `jobStatusEnum` grows with `'rendering' | 'done'` — consumed by Tasks 4-6.

- [ ] **Step 1: Extend the failing schema test**

Add `'renders'` to the `table_name in (...)` list in the existing query, add these to the expected columns array, and extend the existing enum-values test with `'rendering'` and `'done'`:

```
'renders.edit_plan_id',
'renders.job_id',
'renders.storage_key',
'renders.duration_seconds',
'renders.status',
'renders.failure_reason',
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/db/schema.test.ts` — expect FAIL (table and enum values absent).

- [ ] **Step 3: Add the schema**

```typescript
// db/schema.ts
export const jobStatusEnum = pgEnum('job_status', [
  'pending', 'tagging', 'planning', 'planned', 'rendering', 'done', 'failed',
]);

export const renderStatusEnum = pgEnum('render_status', ['rendering', 'done', 'failed']);

export const renders = pgTable('renders', {
  id: uuid('id').primaryKey().defaultRandom(),
  editPlanId: uuid('edit_plan_id').notNull().references(() => editPlans.id),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  storageKey: text('storage_key'),
  durationSeconds: numeric('duration_seconds'),
  status: renderStatusEnum('status').notNull().default('rendering'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

`storageKey` and `durationSeconds` are nullable because a row is written when rendering starts and filled in when it finishes.

- [ ] **Step 4: Generate and apply the migration**

Run: `npx drizzle-kit generate` then `npx drizzle-kit migrate`. Enum values must be **added**, never dropped/recreated — existing rows use `pending`/`planned`/`failed`.

- [ ] **Step 5: Verify tests pass, then commit**

```bash
npm test -- tests/db/schema.test.ts
git add db/schema.ts db/migrations tests/db/schema.test.ts
git commit -m "feat: add renders table and render job statuses"
```

---

## Task 2: ffmpeg foundation and cut normalisation

**Files:**
- Create: `lib/render/ffmpeg.ts`, `lib/render/normalise.ts`
- Test: `tests/lib/render/normalise.test.ts`

**Interfaces:**
- Produces:
  - `runFfmpeg(args: string[]): Promise<{ success: true } | { success: false; error: string }>`
  - `probeDuration(path: string): Promise<number>`
  - `normaliseCut(input: { sourcePath: string; startSeconds: number; endSeconds: number; outputPath: string }): Promise<{ success: true } | { success: false; error: string }>`

Used by Task 3.

- [ ] **Step 1: Install ffmpeg-static**

Run: `npm install ffmpeg-static`

Note its license is GPL-3.0-or-later. We invoke the binary as a separate process rather than linking it, which is the standard usage and does not affect our own code's licensing — but do not vendor its source into ours.

- [ ] **Step 2: Write the ffmpeg runner**

```typescript
// lib/render/ffmpeg.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

/** Longest any single ffmpeg invocation may run before being killed. */
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

function ffmpegBinary(): string {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary for this platform');
  return ffmpegPath;
}

/**
 * Runs ffmpeg with an argument array — never a shell string. Paths on Windows
 * contain colons, backslashes and spaces; passing an array means the OS hands
 * them to the process verbatim with no quoting rules in between.
 */
export async function runFfmpeg(
  args: string[]
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    await execFileAsync(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { success: true };
  } catch (error) {
    // ffmpeg reports the real problem on stderr; the thrown Error's message is
    // usually just the exit code, so prefer stderr when present.
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: (stderr.trim() || message).slice(0, 500) };
  }
}
```

- [ ] **Step 3: Write the failing normalisation test**

The fixture is generated with ffmpeg itself, so the test needs no committed media:

```typescript
// tests/lib/render/normalise.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runFfmpeg } from '@/lib/render/ffmpeg';
import { normaliseCut } from '@/lib/render/normalise';

describe('normaliseCut', () => {
  let dir: string;
  let source: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ugc-normalise-'));
    source = path.join(dir, 'source.mp4');
    // A 10s 640x480 test pattern with a tone: deliberately NOT 9:16, so the
    // test proves the reframing rather than passing through.
    const made = await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30:duration=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source,
    ]);
    expect(made.success).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('trims to the requested range and reframes to 1080x1920', async () => {
    const out = path.join(dir, 'cut.mp4');
    const result = await normaliseCut({
      sourcePath: source, startSeconds: 2, endSeconds: 5, outputPath: out,
    });

    expect(result.success).toBe(true);
    expect(existsSync(out)).toBe(true);

    const { probeDimensions, probeDuration } = await import('@/lib/render/ffmpeg');
    expect(await probeDimensions(out)).toEqual({ width: 1080, height: 1920 });
    // Allow a frame of slack; ffmpeg cuts on frame boundaries.
    expect(await probeDuration(out)).toBeCloseTo(3, 1);
  }, 60_000);

  it('produces an audio track even when the source has none', async () => {
    const silent = path.join(dir, 'silent.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30:duration=5',
      '-c:v', 'libx264', silent,
    ]);

    const out = path.join(dir, 'from-silent.mp4');
    const result = await normaliseCut({
      sourcePath: silent, startSeconds: 0, endSeconds: 3, outputPath: out,
    });

    expect(result.success).toBe(true);
    const { probeHasAudio } = await import('@/lib/render/ffmpeg');
    // Without this, concatenating a silent cut with a noisy one desyncs or fails.
    expect(await probeHasAudio(out)).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- tests/lib/render/normalise.test.ts` — expect FAIL (module absent).

- [ ] **Step 5: Implement probes and normalisation**

Add `probeDuration`, `probeDimensions`, `probeHasAudio` to `lib/render/ffmpeg.ts` using `ffprobe`. Note `ffmpeg-static` ships only ffmpeg; get ffprobe from the `ffprobe-static` package (`npm install ffprobe-static`) rather than assuming a system one.

```typescript
// lib/render/normalise.ts
import { runFfmpeg } from '@/lib/render/ffmpeg';

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

/**
 * Crop-to-fill rather than letterbox: black bars read as amateur in short-form
 * UGC, and the footage is shot vertically anyway. `increase` scales until both
 * dimensions cover the frame, then the crop takes the centre.
 */
const REFRAME =
  `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
  `crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS}`;

export async function normaliseCut(input: {
  sourcePath: string;
  startSeconds: number;
  endSeconds: number;
  outputPath: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const duration = input.endSeconds - input.startSeconds;
  if (!(duration > 0)) {
    return { success: false, error: `Cut has non-positive duration (${duration}s)` };
  }

  // -ss before -i seeks fast; putting it after -i would decode from zero every
  // time, which is slow on a 36s source cut near its end.
  return runFfmpeg([
    '-ss', String(input.startSeconds),
    '-t', String(duration),
    '-i', input.sourcePath,
    // A source with no audio still has to yield an audio track, or concat fails.
    '-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-map', '1:a:0',
    '-filter_complex', `[0:v]${REFRAME}[v];[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    input.outputPath,
  ]);
}
```

**Implementer note:** the audio mapping above is the fiddly part — mixing a real track with silence when one may not exist. If `amix` with an optional input proves unreliable, the robust alternative is to probe for an audio stream first and choose between two simpler command shapes. Prefer whichever passes the "source has none" test; do not leave it half-working.

- [ ] **Step 6: Verify tests pass, then commit**

```bash
npm test -- tests/lib/render/normalise.test.ts
git add lib/render package.json package-lock.json tests/lib/render
git commit -m "feat: add ffmpeg runner and cut normalisation"
```

---

## Task 3: Concatenate cuts and burn in text

**Files:**
- Create: `lib/render/concat.ts`, `lib/render/text.ts`, `assets/fonts/` (committed font)
- Test: `tests/lib/render/concat.test.ts`, `tests/lib/render/text.test.ts`

**Interfaces:**
- Consumes: `runFfmpeg`, probes (Task 2)
- Produces:
  - `concatCuts(paths: string[], outputPath: string): Promise<Result>`
  - `overlayText(input: { sourcePath; outputPath; hookText; sizing?: { text; placement } ; tempDir }): Promise<Result>`

- [ ] **Step 1: Commit a font**

Add a permissively-licensed bold sans-serif TTF under `assets/fonts/` (Inter Bold — SIL OFL, or Roboto Bold — Apache 2.0), plus its license file. **Do not rely on system fonts**: availability differs per machine and would make output environment-dependent.

- [ ] **Step 2: Implement concatenation**

Use the concat *demuxer* (a list file), not the concat *filter* — the inputs are already normalised to identical parameters, so a stream copy is both faster and lossless:

```typescript
// lib/render/concat.ts — sketch; the list file must be written and cleaned up
// ffmpeg args: ['-f','concat','-safe','0','-i', listPath, '-c','copy', outputPath]
```

The list file contains one `file '<absolute path>'` line per cut. Single quotes inside a path must be escaped as `'\''`. Paths should use forward slashes even on Windows.

- [ ] **Step 3: Implement text overlay**

Two `drawtext` filters chained. Requirements:

- **Text comes from a file, never inline.** Write each string to a temp `.txt` (UTF-8, no trailing newline) and pass `textfile=`. Hook text is model-authored and will contain apostrophes and colons, which are `drawtext` metacharacters — inlining it is a guaranteed future bug.
- **The font path needs escaping inside the filter string** even though the rest of the command uses an args array: within a filter graph, `C:\...` must become `C\:/...` (forward slashes, escaped colon). This bites on Windows specifically.
- **Hook:** large (≈72px), white, heavy black border (`borderw`), horizontally centred (`x=(w-text_w)/2`), upper third (`y=h*0.18`), wrapped so long hooks do not run off-frame, visible `between(t,0,3)`.
- **Sizing overlay:** smaller (≈44px), same white-on-black-border treatment, positioned from the six `sizing_overlay_placement` values, visible for 3s starting at a third of the video's duration.

Test both against a rendered fixture: assert the command succeeds, output dimensions are unchanged, and — critically — that a hook containing `POV: it's the "best" one, isn't it?` renders without error. That string contains every metacharacter that breaks naive escaping.

- [ ] **Step 4: Verify tests pass, then commit**

```bash
git add lib/render assets/fonts tests/lib/render
git commit -m "feat: concatenate cuts and burn in hook and sizing text"
```

---

## Task 4: Render a whole EditPlan

**Files:**
- Create: `lib/render/renderPlan.ts`
- Modify: `lib/storage.ts` (add upload-from-file)
- Test: `tests/lib/render/renderPlan.test.ts`

**Interfaces:**
- Consumes: Tasks 2-3, `downloadClipToTempFile` (Stage 2), `db`
- Produces: `renderPlan(editPlanId: string): Promise<{ success: true; storageKey: string; durationSeconds: number } | { success: false; error: string }>` — used by Task 5.

- [ ] **Step 1: Add `uploadRenderedVideo(localPath, storageKey)` to `lib/storage.ts`**

Streams the file to R2 under a `renders/` prefix, reusing the existing `S3Client`. Do not buffer the whole file — rendered videos are large.

- [ ] **Step 2: Implement `renderPlan`**

Sequence: load the EditPlan and its job → download each distinct source clip once (a plan references the same clip many times; downloading per-cut would be wasteful) → normalise every cut → concatenate → overlay text → upload → return the storage key and measured duration.

Requirements:
- Every temp file and directory is removed on success **and** failure. Use a single temp dir per render and remove it in a `finally`.
- Never throws; returns the documented result shape.
- Records nothing to the database itself — the caller owns `renders` rows, keeping this function testable in isolation.

- [ ] **Step 3: Test against real footage**

Build a job, two synthetic source clips, and an EditPlan with cuts drawn from both. Assert: result succeeds, the object exists in R2, its duration is within a frame of the plan's total, and its dimensions are 1080×1920. Clean up the R2 object afterwards.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: render a full edit plan to an uploaded MP4"
```

---

## Task 5: Worker integration

**Files:**
- Modify: `worker.ts`
- Test: `tests/worker.test.ts` (extend)

**Interfaces:**
- Consumes: `renderPlan` (Task 4)
- Produces: worker handles `planned` → `rendering` → `done`

- [ ] **Step 1: Extend the claim to cover renderable jobs**

The existing `claimNextPendingJob` claims `pending` → `tagging`. Add the equivalent for `planned` → `rendering`, using the **same** `FOR UPDATE SKIP LOCKED` single-statement pattern — this is the atomicity guarantee from Stage 2 and must not be weakened or duplicated incorrectly. Prefer generalising the existing query over copy-pasting it.

- [ ] **Step 2: Implement `renderJob(jobId)`**

For each EditPlan of the job: insert a `renders` row (`status: 'rendering'`), call `renderPlan`, then update that row to `done` with the storage key and duration, or `failed` with a reason. **A failing variation must not abort the others.** When all are attempted: if at least one succeeded the job becomes `done`; if every one failed the job becomes `failed` with a combined reason. Mirror the tagging step's partial-failure logging so dropped variations are visible.

- [ ] **Step 3: Extend the worker loop**

The loop should claim and process either kind of work. A job that has just finished planning should be picked up for rendering on a subsequent iteration without manual intervention.

- [ ] **Step 4: Test**

Mock `renderPlan` (rendering is covered by Task 4's real-ffmpeg tests; here the concern is orchestration). Cover: all variations succeed → job `done` and rows filled; one fails → job still `done`, that row `failed`; all fail → job `failed` with a reason.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: render planned jobs from the worker"
```

---

## Task 6: Watch and download the videos

**Files:**
- Create: `app/jobs/[jobId]/page.tsx`, `app/api/jobs/[jobId]/route.ts`
- Modify: `app/jobs/page.tsx`, `lib/storage.ts` (presigned GET)

- [ ] **Step 1: Add `createDownloadUrl(storageKey, expiresIn)` to `lib/storage.ts`**

A presigned **GET** URL so the bucket stays private. Short expiry (~1 hour).

- [ ] **Step 2: Add the job detail API route**

`GET /api/jobs/[jobId]` returns the job plus its variations: variation number, hook text, render status, duration, and a presigned playback URL when done. Enforce the same auth pattern as the other routes — 401 unauthenticated, and the job must belong to the requesting creator (do not trust a client-supplied creator id).

- [ ] **Step 3: Add the job detail page**

Lists each variation with an inline `<video controls>` player, its hook text as the label, and a download link. Failed variations show as failed rather than being silently absent. Show the job's `warning` if present (the short-footage note from Stage 2).

- [ ] **Step 4: Link from the job list**

Each row links to its detail page and shows render status.

- [ ] **Step 5: Manual verification**

`npm run dev`, open a rendered job, confirm each variation plays in the browser and downloads.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: play and download rendered variations"
```

---

## Task 7: End-to-end — watch the real videos

No new code. This is the acceptance check for the whole stage, and for Stage 2's edit quality, which has never been visually verified.

- [ ] **Step 1: Run the full pipeline on the real job**

Start the worker, reset the creator's real job to `pending`, and let it run all the way through tagging → planning → rendering.

- [ ] **Step 2: Watch every variation**

Confirm, by watching: videos play; length matches the request; cuts land every 3-4s and are *visible* as cuts; the hook is legible and on screen at the start; the sizing overlay appears later and is legible; footage is upright and fills the frame with no black bars or stretching; audio is continuous across cuts.

- [ ] **Step 3: Report findings to the human with the files**

Send the actual MP4s. Structural correctness was verified in Stage 2 from timestamps; this step is the first time anyone can judge whether the edits are *good*. Expect notes, and expect at least one round of adjustment — that is the point of this step.

---

## Self-Review Notes

- **Spec coverage:** rendering approach (Tasks 2-4), output format (Task 2), text treatment (Task 3), pipeline and partial-failure isolation (Tasks 4-5), data model (Task 1), creator-facing playback (Task 6), human quality judgement (Task 7). Credits, watermarking, manual editing, and voiceover are all explicitly out of scope per the spec.
- **Known risks are addressed head-on** rather than left to be discovered: shell quoting (args array, Global Constraints), `drawtext` metacharacters (textfile, Task 3), Windows font paths (Task 3), missing audio tracks (Task 2), and mixed source formats (normalise pass).
- **Type consistency:** `runFfmpeg`, `normaliseCut`, `concatCuts`, `overlayText`, `renderPlan` all share the `{ success, ... }` shape used throughout the codebase, and each task names the exact signature the next consumes.
