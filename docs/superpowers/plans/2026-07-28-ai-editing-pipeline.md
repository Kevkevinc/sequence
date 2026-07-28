# AI Editing Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a job's uploaded clips and settings, produce N structurally distinct EditPlans (which segments, in what order, with what hook text) via a background worker process — no video rendering yet (Stage 3).

**Architecture:** A new long-running worker script polls the `jobs` table for `pending` jobs. For each, it calls Gemini once per raw clip to extract candidate segments (tagging), then calls Gemini once more with the full segment pool to produce all N variations in one structured response (directing). Both AI responses are strictly schema-validated before being trusted. Reuses Stage 1's `db`, `getRequiredEnv`, and R2 client.

**Tech Stack:** `@google/genai` (Gemini SDK), `zod` (response validation), existing Drizzle/Postgres/R2 stack from Stage 1.

## Global Constraints

- All server-side env vars are read through `getRequiredEnv()` — never `process.env.X` directly (same convention as Stage 1).
- Gemini model: `gemini-2.5-flash` for tagging (cheaper, sufficient for segment-finding), `gemini-2.5-pro` for the director step (more complex reasoning).
- `GEMINI_API_KEY` is already in `.env.local` and verified working against the real API.
- Every variation's total segment duration must be within ±15% of the job's `length_seconds`, per the spec.
- A segment may repeat within a variation, but never in two consecutive positions.
- No secret/credential values hardcoded anywhere, ever — this project has had a real incident with this before.
- Tests that touch the database run against the real (dev) Supabase project, per Stage 1's established convention.
- Tests that would call the real Gemini API are mocked (the SDK client is mocked at the module boundary) — real-API verification happens via the manual end-to-end task at the end, not in the automated suite, to keep `npm test` fast, free, and rate-limit-safe.
- The `jobs.status` enum grows from `['pending']` (Stage 1) to `['pending', 'tagging', 'planning', 'planned', 'failed']`.

---

## Task 1: Database schema — job status, segments, edit_plans

**Files:**
- Modify: `db/schema.ts`
- Test: `tests/db/schema.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: existing `jobs`, `rawClips` tables (Stage 1)
- Produces: `segments`, `editPlans` Drizzle table objects; `jobs.failureReason` column; `jobStatusEnum` grows to include `'tagging' | 'planning' | 'planned' | 'failed'` — used by every later task in this plan.

- [ ] **Step 1: Write the failing test**

Add to `tests/db/schema.test.ts` (the existing describe block, alongside the Stage 1 assertions — extend the `columns` array being checked and the `table_name in (...)` list in the query):

```typescript
// tests/db/schema.test.ts — modify the existing query and assertion
const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
  select table_name, column_name
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('creators', 'jobs', 'raw_clips', 'segments', 'edit_plans')
`);

const columns = rows.map((r) => `${r.table_name}.${r.column_name}`);

expect(columns).toEqual(
  expect.arrayContaining([
    // ...keep all existing Stage 1 entries, and add:
    'jobs.failure_reason',
    'segments.raw_clip_id',
    'segments.start_seconds',
    'segments.end_seconds',
    'segments.content_tag',
    'segments.quality_tag',
    'edit_plans.job_id',
    'edit_plans.variation_number',
    'edit_plans.segments',
    'edit_plans.hook_text',
    'edit_plans.sizing_overlay_text',
    'edit_plans.sizing_overlay_placement',
  ])
);
```

Also add a second test in the same file:

```typescript
it('accepts the new job_status values', async () => {
  const rows = await db.execute<{ enumlabel: string }>(sql`
    select enumlabel from pg_enum
    join pg_type on pg_enum.enumtypid = pg_type.oid
    where pg_type.typname = 'job_status'
  `);
  const values = rows.map((r) => r.enumlabel);
  expect(values).toEqual(
    expect.arrayContaining(['pending', 'tagging', 'planning', 'planned', 'failed'])
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/db/schema.test.ts`
Expected: FAIL — new columns/tables/enum values don't exist yet.

- [ ] **Step 3: Update the schema**

```typescript
// db/schema.ts — modify the existing jobStatusEnum and jobs table, add two new tables
import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum, numeric, jsonb } from 'drizzle-orm/pg-core';

export const pacingEnum = pgEnum('pacing', ['slow', 'medium', 'fast']);
export const jobStatusEnum = pgEnum('job_status', ['pending', 'tagging', 'planning', 'planned', 'failed']);

// ...creators table unchanged...

export const jobs = pgTable('jobs', {
  // ...all existing columns unchanged...
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id').notNull().references(() => creators.id),
  productName: text('product_name').notNull(),
  sizeWorn: text('size_worn'),
  sizingOverlayEnabled: boolean('sizing_overlay_enabled').notNull().default(false),
  lengthSeconds: integer('length_seconds').notNull(),
  pacing: pacingEnum('pacing').notNull(),
  variationCount: integer('variation_count').notNull(),
  status: jobStatusEnum('status').notNull().default('pending'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ...rawClips table unchanged...

export const segments = pgTable('segments', {
  id: uuid('id').primaryKey().defaultRandom(),
  rawClipId: uuid('raw_clip_id').notNull().references(() => rawClips.id),
  startSeconds: numeric('start_seconds').notNull(),
  endSeconds: numeric('end_seconds').notNull(),
  contentTag: text('content_tag'),
  qualityTag: text('quality_tag'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const editPlans = pgTable('edit_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  variationNumber: integer('variation_number').notNull(),
  segments: jsonb('segments').notNull(),
  hookText: text('hook_text').notNull(),
  sizingOverlayText: text('sizing_overlay_text'),
  sizingOverlayPlacement: text('sizing_overlay_placement'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

(Leave `creators` and `rawClips` exactly as they are — only `jobs` gains `failureReason` and a wider enum.)

- [ ] **Step 4: Generate and apply the migration**

Run: `npx drizzle-kit generate` then `npx drizzle-kit migrate`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/db/schema.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add db/schema.ts db/migrations tests/db/schema.test.ts
git commit -m "feat: extend schema for job statuses, segments, and edit plans"
```

---

## Task 2: R2 clip download helper

**Files:**
- Modify: `lib/storage.ts`
- Test: `tests/lib/storage.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `getRequiredEnv` (Stage 1)
- Produces: `getClipBuffer(storageKey: string): Promise<{ buffer: Buffer; contentType: string }>` — used by Task 3 (tagging) to fetch clip bytes before sending them to Gemini.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/lib/storage.test.ts — add to the existing file
import { Readable } from 'stream';

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: class {
      send = vi.fn(async (command: InstanceType<typeof actual.GetObjectCommand>) => {
        if (command instanceof actual.GetObjectCommand) {
          const stream = Readable.from([Buffer.from('fake-video-bytes')]);
          return { Body: stream, ContentType: 'video/mp4' };
        }
        throw new Error('unexpected command in test');
      });
    },
  };
});

// (this mock replaces the module-level vi.mock('@aws-sdk/s3-request-presigner', ...) setup
// already in this file — keep both vi.mock calls, one per package, at the top of the file)

describe('getClipBuffer', () => {
  it('downloads and returns the clip as a buffer with its content type', async () => {
    const { getClipBuffer } = await import('@/lib/storage');
    const result = await getClipBuffer('clips/some-key.mp4');
    expect(result.buffer.toString()).toBe('fake-video-bytes');
    expect(result.contentType).toBe('video/mp4');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/storage.test.ts`
Expected: FAIL — `getClipBuffer` is not exported.

- [ ] **Step 3: Implement `getClipBuffer`**

```typescript
// lib/storage.ts — add
import { GetObjectCommand } from '@aws-sdk/client-s3';

export async function getClipBuffer(storageKey: string): Promise<{ buffer: Buffer; contentType: string }> {
  const result = await client.send(
    new GetObjectCommand({
      Bucket: getRequiredEnv('R2_BUCKET_NAME'),
      Key: storageKey,
    })
  );

  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return {
    buffer: Buffer.concat(chunks),
    contentType: result.ContentType ?? 'application/octet-stream',
  };
}
```

(`client` here is the existing module-level `S3Client` instance already defined in `lib/storage.ts` from Stage 1 — reuse it, don't create a new one.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/storage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/storage.ts tests/lib/storage.test.ts
git commit -m "feat: add R2 clip download helper for the tagging pipeline"
```

---

## Task 3: Gemini client + tagging step

**Files:**
- Create: `lib/gemini/client.ts`, `lib/pipeline/tagging.ts`
- Test: `tests/lib/pipeline/tagging.test.ts`

**Interfaces:**
- Consumes: `getRequiredEnv` (Stage 1), `getClipBuffer` (Task 2), `db`, `segments`, `rawClips` (Task 1 + Stage 1)
- Produces: `tagClip(rawClipId: string): Promise<{ success: true; segmentCount: number } | { success: false; error: string }>` — used by Task 5 (worker) once per raw clip.

- [ ] **Step 1: Install the Gemini SDK and Zod**

Run: `npm install @google/genai zod`

- [ ] **Step 2: Write the Gemini client wrapper**

```typescript
// lib/gemini/client.ts
import { GoogleGenAI } from '@google/genai';
import { getRequiredEnv } from '@/lib/env';

let client: GoogleGenAI | undefined;

export function getGeminiClient(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({ apiKey: getRequiredEnv('GEMINI_API_KEY') });
  }
  return client;
}
```

- [ ] **Step 3: Write the failing test for `tagClip`**

```typescript
// tests/lib/pipeline/tagging.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

const mockUpload = vi.fn();
const mockGenerateContent = vi.fn();
const mockGetFile = vi.fn();

vi.mock('@/lib/gemini/client', () => ({
  getGeminiClient: () => ({
    files: { upload: mockUpload, get: mockGetFile },
    models: { generateContent: mockGenerateContent },
  }),
}));

vi.mock('@/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage')>();
  return {
    ...actual,
    getClipBuffer: vi.fn(async () => ({ buffer: Buffer.from('fake'), contentType: 'video/mp4' })),
  };
});

import { db } from '@/db/client';
import { creators, jobs, rawClips, segments } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { tagClip } from '@/lib/pipeline/tagging';

describe('tagClip', () => {
  const CLERK_ID = 'test_clerk_user_tagging';
  let rawClipId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const creator = await createCreatorIfNotExists(CLERK_ID);
    const job = await createJob({
      creatorId: creator.id,
      productName: 'Test Product',
      sizingOverlayEnabled: false,
      lengthSeconds: 30,
      pacing: 'medium',
      variationCount: 3,
      clips: [{ storageKey: 'clips/test.mp4', originalFilename: 'test.mp4' }],
    });
    const [clip] = await db.select().from(rawClips).where(eq(rawClips.jobId, job.id));
    rawClipId = clip.id;
    await db.delete(segments).where(eq(segments.rawClipId, rawClipId));
  });

  it('uploads the clip to Gemini, parses candidate segments, and saves them', async () => {
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        segments: [
          { startSeconds: 0, endSeconds: 8, contentTag: 'whole-clip', qualityTag: 'medium' },
          { startSeconds: 2, endSeconds: 5, contentTag: 'try-on', qualityTag: 'high' },
        ],
      }),
    });

    const result = await tagClip(rawClipId);

    expect(result).toEqual({ success: true, segmentCount: 2 });

    const saved = await db.select().from(segments).where(eq(segments.rawClipId, rawClipId));
    expect(saved).toHaveLength(2);
    expect(saved.map((s) => s.contentTag)).toEqual(expect.arrayContaining(['whole-clip', 'try-on']));
  });

  it('returns a failure result instead of throwing when Gemini returns invalid JSON', async () => {
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({ text: 'not valid json' });

    const result = await tagClip(rawClipId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Gemini');
    }
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- tests/lib/pipeline/tagging.test.ts`
Expected: FAIL — `lib/pipeline/tagging.ts` does not exist.

- [ ] **Step 5: Implement the Zod schema and `tagClip`**

```typescript
// lib/pipeline/tagging.ts
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { rawClips, segments } from '@/db/schema';
import { getClipBuffer } from '@/lib/storage';
import { getGeminiClient } from '@/lib/gemini/client';

const TaggingResponseSchema = z.object({
  segments: z
    .array(
      z.object({
        startSeconds: z.number().min(0),
        endSeconds: z.number().min(0),
        contentTag: z.string(),
        qualityTag: z.string(),
      })
    )
    .min(1),
});

const TAGGING_PROMPT = `Analyze this raw video clip for a short-form UGC ad edit.
Always include one segment spanning the entire clip (start 0 to the clip's full duration),
tagged with contentTag "whole-clip". If the clip is long enough to contain additional
distinct good moments, also include those as separate segments with their own start/end
times in seconds. Tag each segment's contentTag as one of: "whole-clip", "b-roll",
"try-on", "other". Tag qualityTag as one of: "low", "medium", "high" based on how
engaging/usable the moment is (steady footage, clear subject, good lighting).
Respond with JSON only, matching this shape:
{"segments": [{"startSeconds": number, "endSeconds": number, "contentTag": string, "qualityTag": string}]}`;

async function waitUntilActive(client: ReturnType<typeof getGeminiClient>, fileName: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const file = await client.files.get({ name: fileName });
    if (file.state === 'ACTIVE') return;
    if (file.state === 'FAILED') throw new Error('Gemini file processing failed');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Gemini file did not become ACTIVE in time');
}

export async function tagClip(
  rawClipId: string
): Promise<{ success: true; segmentCount: number } | { success: false; error: string }> {
  try {
    const [clip] = await db.select().from(rawClips).where(eq(rawClips.id, rawClipId));
    if (!clip) return { success: false, error: `Raw clip ${rawClipId} not found` };

    const { buffer, contentType } = await getClipBuffer(clip.storageKey);
    const client = getGeminiClient();

    const uploaded = await client.files.upload({
      file: buffer,
      config: { mimeType: contentType },
    });
    if (uploaded.state !== 'ACTIVE') {
      await waitUntilActive(client, uploaded.name!);
    }

    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: uploaded.uri!, mimeType: uploaded.mimeType! } },
            { text: TAGGING_PROMPT },
          ],
        },
      ],
      config: { responseMimeType: 'application/json' },
    });

    let parsed;
    try {
      parsed = TaggingResponseSchema.parse(JSON.parse(response.text ?? ''));
    } catch {
      return { success: false, error: 'Gemini returned invalid or unparseable JSON for tagging' };
    }

    await db.insert(segments).values(
      parsed.segments.map((s) => ({
        rawClipId,
        startSeconds: s.startSeconds.toString(),
        endSeconds: s.endSeconds.toString(),
        contentTag: s.contentTag,
        qualityTag: s.qualityTag,
      }))
    );

    return { success: true, segmentCount: parsed.segments.length };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- tests/lib/pipeline/tagging.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add lib/gemini lib/pipeline/tagging.ts tests/lib/pipeline/tagging.test.ts package.json package-lock.json
git commit -m "feat: add Gemini-based clip tagging step"
```

---

## Task 4: Director step (variation generation)

**Files:**
- Create: `lib/pipeline/hookLibrary.ts`, `lib/pipeline/director.ts`
- Test: `tests/lib/pipeline/director.test.ts`

**Interfaces:**
- Consumes: `getGeminiClient` (Task 3), `db`, `segments`, `editPlans`, `jobs`, `rawClips` (Task 1 + Stage 1)
- Produces: `planJob(jobId: string): Promise<{ success: true; variationCount: number } | { success: false; error: string }>` — used by Task 5 (worker) once per job, after all its clips are tagged.

- [ ] **Step 1: Write the hook-style reference library**

```typescript
// lib/pipeline/hookLibrary.ts
export const HOOK_STYLE_LIBRARY = [
  'POV: you just found the [product] everyone is talking about',
  "Things I wish I knew before buying [product]",
  "Wait until you see how this [product] fits",
  "You NEED this [product] if you're tired of [common problem]",
  "Is this [product] actually worth the hype? Let's find out",
  "Nobody told me [product] would look this good",
  "3 reasons I'm obsessed with this [product]",
] as const;
```

- [ ] **Step 2: Write the failing test for `planJob`**

```typescript
// tests/lib/pipeline/director.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

const mockGenerateContent = vi.fn();

vi.mock('@/lib/gemini/client', () => ({
  getGeminiClient: () => ({ models: { generateContent: mockGenerateContent } }),
}));

import { db } from '@/db/client';
import { jobs, rawClips, segments, editPlans } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { planJob } from '@/lib/pipeline/director';

describe('planJob', () => {
  const CLERK_ID = 'test_clerk_user_director';
  let jobId: string;
  let clipAId: string;
  let clipBId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const creator = await createCreatorIfNotExists(CLERK_ID);
    const job = await createJob({
      creatorId: creator.id,
      productName: 'Cozy Hoodie',
      sizingOverlayEnabled: false,
      lengthSeconds: 15,
      pacing: 'medium',
      variationCount: 2,
      clips: [
        { storageKey: 'clips/a.mp4', originalFilename: 'a.mp4' },
        { storageKey: 'clips/b.mp4', originalFilename: 'b.mp4' },
      ],
    });
    jobId = job.id;
    const clips = await db.select().from(rawClips).where(eq(rawClips.jobId, jobId));
    clipAId = clips[0].id;
    clipBId = clips[1].id;

    await db.delete(editPlans).where(eq(editPlans.jobId, jobId));
    await db.delete(segments).where(eq(segments.rawClipId, clipAId));
    await db.delete(segments).where(eq(segments.rawClipId, clipBId));
    await db.insert(segments).values([
      { rawClipId: clipAId, startSeconds: '0', endSeconds: '8', contentTag: 'whole-clip', qualityTag: 'high' },
      { rawClipId: clipBId, startSeconds: '0', endSeconds: '10', contentTag: 'whole-clip', qualityTag: 'medium' },
      { rawClipId: clipBId, startSeconds: '2', endSeconds: '6', contentTag: 'try-on', qualityTag: 'high' },
    ]);
  });

  it('produces and saves the requested number of variations', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        variations: [
          {
            segments: [
              { rawClipId: clipAId, startSeconds: 0, endSeconds: 8 },
              { rawClipId: clipBId, startSeconds: 2, endSeconds: 6 },
            ],
            hookText: 'POV: you just found the Cozy Hoodie everyone is talking about',
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
          {
            segments: [
              { rawClipId: clipBId, startSeconds: 0, endSeconds: 10 },
              { rawClipId: clipAId, startSeconds: 0, endSeconds: 8 },
            ],
            hookText: "Things I wish I knew before buying this Cozy Hoodie",
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
        ],
      }),
    });

    const result = await planJob(jobId);

    expect(result).toEqual({ success: true, variationCount: 2 });

    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(2);
    expect(saved.map((p) => p.variationNumber).sort()).toEqual([1, 2]);
  });

  it('returns a failure result when Gemini output fails schema validation twice', async () => {
    mockGenerateContent.mockResolvedValue({ text: 'not valid json' });

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/lib/pipeline/director.test.ts`
Expected: FAIL — `lib/pipeline/director.ts` does not exist.

- [ ] **Step 4: Implement the Zod schema and `planJob`**

```typescript
// lib/pipeline/director.ts
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips, segments, editPlans } from '@/db/schema';
import { getGeminiClient } from '@/lib/gemini/client';
import { HOOK_STYLE_LIBRARY } from '@/lib/pipeline/hookLibrary';

const VariationSchema = z.object({
  segments: z
    .array(
      z.object({
        rawClipId: z.string().uuid(),
        startSeconds: z.number().min(0),
        endSeconds: z.number().min(0),
      })
    )
    .min(1),
  hookText: z.string().min(1),
  sizingOverlayText: z.string().nullable(),
  sizingOverlayPlacement: z.string().nullable(),
});

const DirectorResponseSchema = z.object({
  variations: z.array(VariationSchema).min(1),
});

function buildPrompt(
  job: { productName: string; lengthSeconds: number; pacing: string; variationCount: number },
  segmentPool: { id: string; rawClipId: string; startSeconds: string; endSeconds: string; contentTag: string | null; qualityTag: string | null }[],
  correctionNote?: string
) {
  return `You are editing a short-form UGC ad video for the product "${job.productName}".
Target length: ${job.lengthSeconds} seconds. Pacing: ${job.pacing}.
Produce exactly ${job.variationCount} distinct variations.

Available segments (choose from these only, by id):
${JSON.stringify(segmentPool.map((s) => ({ id: s.id, rawClipId: s.rawClipId, startSeconds: s.startSeconds, endSeconds: s.endSeconds, contentTag: s.contentTag, qualityTag: s.qualityTag })))}

Each variation's segments should sum to within 15% of the target length.
If there are not enough distinct good segments to reach the target length, you may
reuse a segment more than once, but never in two consecutive positions in the sequence.

Hook text should be adapted from this style library to fit the product (not copied verbatim):
${JSON.stringify(HOOK_STYLE_LIBRARY)}

${correctionNote ? `Your previous response was invalid: ${correctionNote}\nPlease fix it.` : ''}

Respond with JSON only, matching this shape:
{"variations": [{"segments": [{"rawClipId": string, "startSeconds": number, "endSeconds": number}], "hookText": string, "sizingOverlayText": string | null, "sizingOverlayPlacement": string | null}]}`;
}

export async function planJob(
  jobId: string
): Promise<{ success: true; variationCount: number } | { success: false; error: string }> {
  try {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job) return { success: false, error: `Job ${jobId} not found` };

    const clips = await db.select().from(rawClips).where(eq(rawClips.jobId, jobId));
    const clipIds = clips.map((c) => c.id);
    const segmentPool = (
      await Promise.all(clipIds.map((id) => db.select().from(segments).where(eq(segments.rawClipId, id))))
    ).flat();

    if (segmentPool.length === 0) {
      return { success: false, error: 'No usable segments were found for this job' };
    }

    const client = getGeminiClient();
    let correctionNote: string | undefined;
    let parsed: z.infer<typeof DirectorResponseSchema> | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await client.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: [{ role: 'user', parts: [{ text: buildPrompt(job, segmentPool, correctionNote) }] }],
        config: { responseMimeType: 'application/json' },
      });

      try {
        parsed = DirectorResponseSchema.parse(JSON.parse(response.text ?? ''));
        break;
      } catch (validationError) {
        correctionNote = validationError instanceof Error ? validationError.message : String(validationError);
        parsed = undefined;
      }
    }

    if (!parsed) {
      return { success: false, error: 'Gemini did not produce a valid edit plan after retries' };
    }

    await db.insert(editPlans).values(
      parsed.variations.map((v, index) => ({
        jobId,
        variationNumber: index + 1,
        segments: v.segments,
        hookText: v.hookText,
        sizingOverlayText: v.sizingOverlayText,
        sizingOverlayPlacement: v.sizingOverlayPlacement,
      }))
    );

    return { success: true, variationCount: parsed.variations.length };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/lib/pipeline/director.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline/hookLibrary.ts lib/pipeline/director.ts tests/lib/pipeline/director.test.ts
git commit -m "feat: add director step producing N edit-plan variations"
```

---

## Task 5: Worker process

**Files:**
- Create: `worker.ts`
- Modify: `package.json` (add `"worker"` script)
- Test: `tests/worker.test.ts`

**Interfaces:**
- Consumes: `tagClip` (Task 3), `planJob` (Task 4), `db`, `jobs`, `rawClips` (Task 1 + Stage 1)
- Produces: `claimNextPendingJob(): Promise<{ id: string } | undefined>`, `processJob(jobId: string): Promise<void>` — the worker's main loop calls these; also the entrypoint script itself (not imported elsewhere, but this is what a human runs).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('@/lib/pipeline/tagging', () => ({ tagClip: vi.fn() }));
vi.mock('@/lib/pipeline/director', () => ({ planJob: vi.fn() }));

import { db } from '@/db/client';
import { jobs, rawClips } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { tagClip } from '@/lib/pipeline/tagging';
import { planJob } from '@/lib/pipeline/director';
import { claimNextPendingJob, processJob } from '@/worker';

describe('worker', () => {
  const CLERK_ID = 'test_clerk_user_worker';

  async function makeJob() {
    const creator = await createCreatorIfNotExists(CLERK_ID);
    return createJob({
      creatorId: creator.id,
      productName: 'Worker Test Product',
      sizingOverlayEnabled: false,
      lengthSeconds: 15,
      pacing: 'fast',
      variationCount: 1,
      clips: [{ storageKey: 'clips/w.mp4', originalFilename: 'w.mp4' }],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims a pending job and moves it to tagging', async () => {
    const job = await makeJob();
    const claimed = await claimNextPendingJob();
    expect(claimed?.id).toBeDefined();

    const [updated] = await db.select().from(jobs).where(eq(jobs.id, claimed!.id));
    expect(updated.status).toBe('tagging');
  });

  it('processes a job end to end: tags all clips, plans it, marks planned', async () => {
    const job = await makeJob();
    vi.mocked(tagClip).mockResolvedValue({ success: true, segmentCount: 1 });
    vi.mocked(planJob).mockResolvedValue({ success: true, variationCount: 1 });

    await processJob(job.id);

    expect(tagClip).toHaveBeenCalledTimes(1);
    expect(planJob).toHaveBeenCalledWith(job.id);

    const [updated] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.status).toBe('planned');
  });

  it('marks the job failed with a reason when every clip fails tagging', async () => {
    const job = await makeJob();
    vi.mocked(tagClip).mockResolvedValue({ success: false, error: 'clip unreadable' });

    await processJob(job.id);

    expect(planJob).not.toHaveBeenCalled();

    const [updated] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.status).toBe('failed');
    expect(updated.failureReason).toContain('clip unreadable');
  });

  it('marks the job failed with a reason when planning fails', async () => {
    const job = await makeJob();
    vi.mocked(tagClip).mockResolvedValue({ success: true, segmentCount: 2 });
    vi.mocked(planJob).mockResolvedValue({ success: false, error: 'no valid plan' });

    await processJob(job.id);

    const [updated] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.status).toBe('failed');
    expect(updated.failureReason).toContain('no valid plan');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/worker.test.ts`
Expected: FAIL — `worker.ts` does not exist.

- [ ] **Step 3: Implement the worker**

```typescript
// worker.ts
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips } from '@/db/schema';
import { tagClip } from '@/lib/pipeline/tagging';
import { planJob } from '@/lib/pipeline/director';

export async function claimNextPendingJob(): Promise<{ id: string } | undefined> {
  const [claimed] = await db
    .update(jobs)
    .set({ status: 'tagging' })
    .where(
      eq(
        jobs.id,
        db
          .select({ id: jobs.id })
          .from(jobs)
          .where(eq(jobs.status, 'pending'))
          .limit(1)
      )
    )
    .returning({ id: jobs.id });
  return claimed;
}

export async function processJob(jobId: string): Promise<void> {
  const clips = await db.select().from(rawClips).where(eq(rawClips.jobId, jobId));

  const tagResults = await Promise.all(clips.map((clip) => tagClip(clip.id)));
  const anySucceeded = tagResults.some((r) => r.success);

  if (!anySucceeded) {
    const reasons = tagResults.map((r) => (r.success ? '' : r.error)).filter(Boolean).join('; ');
    await db
      .update(jobs)
      .set({ status: 'failed', failureReason: `All clips failed tagging: ${reasons}` })
      .where(eq(jobs.id, jobId));
    return;
  }

  await db.update(jobs).set({ status: 'planning' }).where(eq(jobs.id, jobId));

  const planResult = await planJob(jobId);

  if (!planResult.success) {
    await db
      .update(jobs)
      .set({ status: 'failed', failureReason: planResult.error })
      .where(eq(jobs.id, jobId));
    return;
  }

  await db.update(jobs).set({ status: 'planned' }).where(eq(jobs.id, jobId));
}

async function main() {
  console.log('Worker started, polling for pending jobs every 5 seconds...');
  for (;;) {
    const claimed = await claimNextPendingJob();
    if (claimed) {
      console.log(`Processing job ${claimed.id}...`);
      await processJob(claimed.id);
      console.log(`Finished job ${claimed.id}.`);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

if (require.main === module) {
  main();
}
```

**Note for the implementer:** the subquery inside `claimNextPendingJob`'s `.where(eq(jobs.id, ...))` needs to actually compile as a scalar subquery under Drizzle's query builder — if `db.select(...).where(...).limit(1)` doesn't work directly as an `eq()` operand in this Drizzle version, use `sql` template syntax instead, e.g. `where(sql`id = (select id from jobs where status = 'pending' limit 1)`)`. Verify against installed Drizzle's docs/types and adjust the exact syntax as needed — the important behavior is: atomically pick one `pending` job and flip it to `tagging` in a single statement (so two worker instances can never claim the same job).

- [ ] **Step 4: Add the npm script**

```json
// package.json — add to "scripts"
"worker": "tsx worker.ts"
```

Run: `npm install -D tsx` if not already present.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/worker.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add worker.ts tests/worker.test.ts package.json package-lock.json
git commit -m "feat: add background worker to process jobs through tagging and directing"
```

---

## Task 6: End-to-end manual verification

This task has no new code — it's confirming the real pipeline works against real clips using the real Gemini API, following the plan's testing strategy (Gemini's free tier, no cost).

- [ ] **Step 1: Start the worker**

Run: `npm run worker` in one terminal, leave it running.

- [ ] **Step 2: Create a real job**

Using the app (`npm run dev` in another terminal), sign in and create a job with 2-3 short real clips, a product name, and 2-3 variations.

- [ ] **Step 3: Watch it process**

The worker terminal should log the job being picked up, processed, and finishing. This can take a minute or two per clip (video upload + Gemini processing time).

- [ ] **Step 4: Inspect the result**

Query the database directly to confirm:
- The job's `status` ended at `planned` (or `failed` with a sensible `failure_reason` if something went wrong — investigate if so).
- `segments` rows exist for each clip.
- `edit_plans` rows exist — one per requested variation, each with a plausible-sounding `hook_text` and a `segments` array whose timestamps make sense against the source clips.

- [ ] **Step 5: Report findings**

Summarize what was found in plain language (which clips were used in which order, what the hook text says, whether it looks like a sensible edit) — this is the actual acceptance check for this stage, per the design spec.

---

## Self-Review Notes

- **Spec coverage:** tagging (Task 3), director/variations (Task 4), worker/job-status-transitions (Task 5), schema (Task 1), R2 fetch (Task 2), real-world verification (Task 6). Reference-video style transfer is out of scope per the spec and not included here.
- **No placeholders:** every step has real, runnable code or exact manual instructions.
- **Type consistency:** `tagClip(rawClipId: string)`, `planJob(jobId: string)`, `claimNextPendingJob()`, `processJob(jobId: string)` are defined once and referenced by name consistently across Tasks 3-5. The `{success: true, ...} | {success: false, error: string}` result shape is used identically by both pipeline functions and consumed the same way in the worker.
