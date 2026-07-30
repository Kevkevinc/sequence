# Creator Styles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a creator either configure a video manually (today's "Custom" flow) or pick a pre-built "Style" card that bundles cut rhythm, hook tone, sizing placement, text color, clip ordering, and an optional inspiration-photo overlay — with nothing left to configure.

**Architecture:** A new `styles` table holds a flexible `config` JSONB blob per style. `jobs.pacing` becomes nullable and a nullable `jobs.styleId` is added; exactly one of the two is set per job. The director step (`lib/pipeline/director.ts`) resolves an `EffectivePreset` from either the job's `pacing` (Custom mode) or its style's `config` (Style mode) and uses that uniformly for cut-band, hook library, sizing placement, and (new) per-variation clip ordering. The renderer (`lib/render/text.ts`, `lib/render/renderPlan.ts`) resolves the job's style separately, at render time, to pick text color and to composite an optional inspiration photo.

**Tech Stack:** Existing stack only — Drizzle/Postgres, `@google/genai`, `zod`, `ffmpeg-static`/`@napi-rs/canvas`, Next.js API routes, `vitest`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-creator-styles-design.md`.
- All server-side env vars are read through `getRequiredEnv()`/`getEnvWithDefault()` — never `process.env.X` directly.
- Tests that touch the database run against the real (dev) Supabase project, per this codebase's established convention — no mocking Drizzle/Postgres.
- Tests that would call the real Gemini API mock the SDK client at the module boundary (`vi.mock('@/lib/gemini/client', ...)`), exactly as `tests/lib/pipeline/director.test.ts` already does.
- Schema changes go through `npx drizzle-kit generate` then `npx drizzle-kit migrate` (see `db/migrations`), never hand-written SQL.
- Untrusted JSONB (a style's `config`, same as an edit plan's `segments`) is `zod`-parsed on the way out of the database, never trusted at the TypeScript type level alone — matches the existing pattern in `lib/render/renderPlan.ts`.
- Exactly one of `pacing` / `styleId` is set on a `jobs` row; enforced in `lib/validation/job.ts`, not a DB constraint (matches this codebase's existing preference for application-level validation over DB constraints beyond foreign keys).
- v1 style techniques are exactly: cut rhythm, hook tone, sizing placement, text color, clip-order variation across variations, and a single manually-uploaded inspiration photo. Nothing else (no thumbnails, no auto-sourced images, no multi-photo collages).
- The spec's `hookPosition` field is deliberately **not** implemented: it was marked "reserved for future values" with both v1 styles using today's fixed hook layout, so it would be a config key with no behavior behind it. Add it (and the rendering support for a second position) only when a real style needs a hook position other than today's upper-third-centered default.

---

## Task 1: Database schema — styles, nullable job pacing, inspiration images

**Files:**
- Modify: `db/schema.ts`
- Test: `tests/db/schema.test.ts` (extend the existing file)

**Interfaces:**
- Produces: `styles` table (`id`, `creatorId` nullable, `name`, `description`, `config` jsonb), `jobs.styleId` (nullable, references `styles.id`), `jobs.pacing` now nullable, `jobInspirationImages` table (`id`, `jobId`, `storageKey`) — used by every later task in this plan.

- [ ] **Step 1: Write the failing test**

Add to `tests/db/schema.test.ts`:

```typescript
it('makes jobs.pacing nullable and adds jobs.style_id, styles, and job_inspiration_images', async () => {
  const rows = await db.execute<{ table_name: string; column_name: string; is_nullable: string }>(sql`
    select table_name, column_name, is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('jobs', 'styles', 'job_inspiration_images')
  `);

  const columns = rows.map((r) => `${r.table_name}.${r.column_name}`);
  expect(columns).toEqual(
    expect.arrayContaining([
      'jobs.style_id',
      'styles.id',
      'styles.creator_id',
      'styles.name',
      'styles.description',
      'styles.config',
      'styles.created_at',
      'job_inspiration_images.id',
      'job_inspiration_images.job_id',
      'job_inspiration_images.storage_key',
    ])
  );

  const pacingColumn = rows.find((r) => r.table_name === 'jobs' && r.column_name === 'pacing');
  expect(pacingColumn?.is_nullable).toBe('YES');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/db/schema.test.ts`
Expected: FAIL — `styles` and `job_inspiration_images` don't exist yet, and `jobs.pacing` is still `NOT NULL`.

- [ ] **Step 3: Update the schema**

In `db/schema.ts`:
- Remove `.notNull()` from `jobs.pacing`.
- Add `styleId: uuid('style_id').references(() => styles.id),` to the `jobs` table (must be declared after `styles`, or use a forward-referenced callback the way `creators`/`jobs` already do it — declare `styles` before `jobs` in the file).
- Add the two new tables.

```typescript
import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum, numeric, jsonb } from 'drizzle-orm/pg-core';

export const pacingEnum = pgEnum('pacing', ['slow', 'medium', 'fast']);
export const jobStatusEnum = pgEnum('job_status', [
  'pending', 'tagging', 'planning', 'planned', 'rendering', 'done', 'failed',
]);
export const renderStatusEnum = pgEnum('render_status', ['rendering', 'done', 'failed']);

export const creators = pgTable('creators', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  height: text('height'),
  weight: text('weight'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Declared before `jobs` so `jobs.styleId` can reference it directly.
export const styles = pgTable('styles', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Null = a built-in/system style. Filled in later by the (not-yet-built) paid
  // feature where a creator saves their own AI-analyzed style.
  creatorId: uuid('creator_id').references(() => creators.id),
  name: text('name').notNull(),
  description: text('description').notNull(),
  config: jsonb('config').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id').notNull().references(() => creators.id),
  productName: text('product_name').notNull(),
  sizeWorn: text('size_worn'),
  sizingOverlayEnabled: boolean('sizing_overlay_enabled').notNull().default(false),
  lengthSeconds: integer('length_seconds').notNull(),
  // Nullable: set only in Custom mode. Style mode leaves this null and sets styleId instead.
  pacing: pacingEnum('pacing'),
  styleId: uuid('style_id').references(() => styles.id),
  variationCount: integer('variation_count').notNull(),
  status: jobStatusEnum('status').notNull().default('pending'),
  failureReason: text('failure_reason'),
  warning: text('warning'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rawClips = pgTable('raw_clips', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  storageKey: text('storage_key').notNull(),
  originalFilename: text('original_filename').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// One row per job for v1 (a style either doesn't use this or a job supplies
// exactly one photo) — a table rather than a column on `jobs` so a future
// multi-photo enhancement is new rows, not a new migration.
export const jobInspirationImages = pgTable('job_inspiration_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  storageKey: text('storage_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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

- [ ] **Step 4: Generate and apply the migration**

Run: `npx drizzle-kit generate` then `npx drizzle-kit migrate`

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/db/schema.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add db/schema.ts db/migrations tests/db/schema.test.ts
git commit -m "feat: add styles table, nullable job pacing, inspiration images table"
```

---

## Task 2: Style config schema, repository, and the two v1 seeded styles

**Files:**
- Create: `lib/styles.ts`
- Create: `db/repositories/styles.ts`
- Create: `db/seed-styles.ts`
- Modify: `package.json` (add a `seed:styles` script)
- Test: `tests/lib/styles.test.ts`, `tests/db/repositories/styles.test.ts`

**Interfaces:**
- Consumes: `styles` table (Task 1).
- Produces: `StyleConfigSchema`, `type StyleConfig` (used by Task 3's job-creation API, Task 6/7's director, Task 8/9's renderer); `listStyles()`, `getStyleById(id)` (used by Task 3 and Task 4); `seedBuiltInStyles()` (idempotent, used by Task 10's manual verification and by anyone standing up a fresh dev database).

- [ ] **Step 1: Write the failing test for the config schema**

Create `tests/lib/styles.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { StyleConfigSchema } from '@/lib/styles';

describe('StyleConfigSchema', () => {
  it('accepts a minimal valid config', () => {
    const result = StyleConfigSchema.safeParse({
      cutMinSeconds: 2,
      cutMaxSeconds: 5,
      hookStyleLibrary: ['Affordable Designer Alternatives..'],
      variesClipOrder: true,
      usesInspirationOverlay: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts the optional textColor and sizingPlacement fields', () => {
    const result = StyleConfigSchema.safeParse({
      cutMinSeconds: 15,
      cutMaxSeconds: 45,
      hookStyleLibrary: ['new fav [item]'],
      textColor: '#ffcc00',
      sizingPlacement: 'bottom-right',
      variesClipOrder: false,
      usesInspirationOverlay: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a config missing a required field', () => {
    const result = StyleConfigSchema.safeParse({
      cutMinSeconds: 2,
      cutMaxSeconds: 5,
      hookStyleLibrary: ['x'],
      usesInspirationOverlay: false,
      // variesClipOrder missing
    });
    expect(result.success).toBe(false);
  });

  it('rejects a sizingPlacement outside the shared OVERLAY_PLACEMENTS list', () => {
    const result = StyleConfigSchema.safeParse({
      cutMinSeconds: 2,
      cutMaxSeconds: 5,
      hookStyleLibrary: ['x'],
      sizingPlacement: 'middle-of-nowhere',
      variesClipOrder: false,
      usesInspirationOverlay: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty hookStyleLibrary', () => {
    const result = StyleConfigSchema.safeParse({
      cutMinSeconds: 2,
      cutMaxSeconds: 5,
      hookStyleLibrary: [],
      variesClipOrder: false,
      usesInspirationOverlay: false,
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/styles.test.ts`
Expected: FAIL — `@/lib/styles` doesn't exist yet.

- [ ] **Step 3: Write `lib/styles.ts`**

```typescript
import { z } from 'zod';
import { OVERLAY_PLACEMENTS } from '@/lib/editPlan';

/**
 * A style's whole editing recipe, stored as `styles.config` (JSONB).
 *
 * A flexible blob rather than one column per technique: a new technique later
 * is a new key here plus the code that acts on it, not a schema migration.
 * Each known key is still hand-interpreted code, never a generic rules engine.
 */
export const StyleConfigSchema = z.object({
  /** The "ideal" per-cut range this style's edits aim for, before pacing tolerance widens it. */
  cutMinSeconds: z.number().positive(),
  cutMaxSeconds: z.number().positive(),
  /** Replaces the global HOOK_STYLE_LIBRARY for jobs using this style. */
  hookStyleLibrary: z.array(z.string()).min(1),
  /** Hex color for hook/sizing text. Unset = today's default (white fill, black outline). */
  textColor: z.string().optional(),
  /** Pins sizing text to one corner for every variation of this style, instead of letting the director pick freely. */
  sizingPlacement: z.enum(OVERLAY_PLACEMENTS).optional(),
  /** Whether the director rotates each variation between b-roll-first / try-on-first / mixed clip ordering. */
  variesClipOrder: z.boolean(),
  /** Whether job creation asks for one inspiration photo, composited early in the render. */
  usesInspirationOverlay: z.boolean(),
});

export type StyleConfig = z.infer<typeof StyleConfigSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/styles.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for the repository**

Create `tests/db/repositories/styles.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { styles } from '@/db/schema';
import { listStyles, getStyleById } from '@/db/repositories/styles';

describe('styles repository', () => {
  const NAME_A = 'Test Repo Style A';
  const NAME_B = 'Test Repo Style B';

  beforeEach(async () => {
    await db.delete(styles).where(eq(styles.name, NAME_A));
    await db.delete(styles).where(eq(styles.name, NAME_B));
  });

  it('lists styles and fetches one by id', async () => {
    const [a] = await db
      .insert(styles)
      .values({
        name: NAME_A,
        description: 'First test style',
        config: { cutMinSeconds: 2, cutMaxSeconds: 5, hookStyleLibrary: ['x'], variesClipOrder: false, usesInspirationOverlay: false },
      })
      .returning();
    await db.insert(styles).values({
      name: NAME_B,
      description: 'Second test style',
      config: { cutMinSeconds: 15, cutMaxSeconds: 45, hookStyleLibrary: ['y'], variesClipOrder: false, usesInspirationOverlay: false },
    });

    const all = await listStyles();
    expect(all.map((s) => s.name)).toEqual(expect.arrayContaining([NAME_A, NAME_B]));

    const fetched = await getStyleById(a.id);
    expect(fetched?.name).toBe(NAME_A);
  });

  it('returns undefined for an id that does not exist', async () => {
    const result = await getStyleById('00000000-0000-0000-0000-000000000000');
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- tests/db/repositories/styles.test.ts`
Expected: FAIL — `@/db/repositories/styles` doesn't exist yet.

- [ ] **Step 7: Write `db/repositories/styles.ts`**

```typescript
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { styles } from '@/db/schema';

export async function listStyles() {
  return db.query.styles.findMany({ orderBy: (s, { asc }) => asc(s.createdAt) });
}

export async function getStyleById(id: string) {
  return db.query.styles.findFirst({ where: eq(styles.id, id) });
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- tests/db/repositories/styles.test.ts`
Expected: PASS

- [ ] **Step 9: Write the failing test for seeding the two v1 styles**

Add to `tests/db/repositories/styles.test.ts`:

```typescript
import { seedBuiltInStyles } from '@/db/seed-styles';

// ...inside the existing describe block, or a new one:

describe('seedBuiltInStyles', () => {
  it('creates the two v1 styles with their real derived config, and is idempotent', async () => {
    await seedBuiltInStyles();
    await seedBuiltInStyles(); // running it twice must not duplicate rows

    const all = await listStyles();
    const singleShot = all.find((s) => s.name === 'Single-Shot Try-On');
    const dupeFlip = all.find((s) => s.name === 'Dupe Flip');

    expect(all.filter((s) => s.name === 'Single-Shot Try-On')).toHaveLength(1);
    expect(all.filter((s) => s.name === 'Dupe Flip')).toHaveLength(1);

    expect(singleShot?.config).toMatchObject({
      cutMinSeconds: 15,
      cutMaxSeconds: 45,
      sizingPlacement: 'bottom-right',
      variesClipOrder: false,
      usesInspirationOverlay: false,
    });
    expect(dupeFlip?.config).toMatchObject({
      cutMinSeconds: 2,
      cutMaxSeconds: 5,
      sizingPlacement: 'bottom-left',
      variesClipOrder: true,
      usesInspirationOverlay: true,
    });
  });
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npm test -- tests/db/repositories/styles.test.ts`
Expected: FAIL — `@/db/seed-styles` doesn't exist yet.

- [ ] **Step 11: Write `db/seed-styles.ts`**

```typescript
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { styles } from '@/db/schema';
import type { StyleConfig } from '@/lib/styles';

/**
 * The two v1 styles, hand-authored from real reference video (frame sampling
 * plus ffmpeg scene-cut detection on 3 example clips per style — see
 * docs/superpowers/specs/2026-07-30-creator-styles-design.md).
 */
const BUILT_IN_STYLES: { name: string; description: string; config: StyleConfig }[] = [
  {
    name: 'Single-Shot Try-On',
    description: 'One continuous take, casual caption, sizing in the bottom-right.',
    config: {
      cutMinSeconds: 15,
      cutMaxSeconds: 45,
      hookStyleLibrary: [
        'new fav [item]',
        'toughest [item] yet',
        'this [item] hits different',
        'okay this [item] might be my favorite',
        'wait til you see this [item]',
      ],
      sizingPlacement: 'bottom-right',
      variesClipOrder: false,
      usesInspirationOverlay: false,
    },
  },
  {
    name: 'Dupe Flip',
    description: 'Fast-cut b-roll into try-on, bold caption, sizing bottom-left, optional inspiration photo.',
    config: {
      cutMinSeconds: 2,
      cutMaxSeconds: 5,
      hookStyleLibrary: [
        'Affordable Designer Alternatives..',
        'How To Dress As A [X]..',
        '[Item] Under $100',
        '[Item] Dupes You Need To Know About',
        'Get The Look For Less..',
      ],
      sizingPlacement: 'bottom-left',
      variesClipOrder: true,
      usesInspirationOverlay: true,
    },
  },
];

/** Idempotent: safe to run against a fresh database or one that already has these rows. */
export async function seedBuiltInStyles(): Promise<void> {
  for (const style of BUILT_IN_STYLES) {
    const existing = await db.query.styles.findFirst({ where: eq(styles.name, style.name) });
    if (existing) continue;
    await db.insert(styles).values(style);
  }
}

// Run directly via `npm run seed:styles`; not imported by the app at runtime.
if (require.main === module) {
  seedBuiltInStyles()
    .then(() => {
      console.log('Seeded built-in styles.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Failed to seed built-in styles:', error);
      process.exit(1);
    });
}
```

- [ ] **Step 12: Add the npm script**

In `package.json`'s `"scripts"`:

```json
"seed:styles": "tsx --env-file-if-exists=.env.local db/seed-styles.ts"
```

- [ ] **Step 13: Run the tests to verify they pass**

Run: `npm test -- tests/db/repositories/styles.test.ts`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add lib/styles.ts db/repositories/styles.ts db/seed-styles.ts package.json tests/lib/styles.test.ts tests/db/repositories/styles.test.ts
git commit -m "feat: add style config schema, repository, and seed the two v1 styles"
```

---

## Task 3: Job creation supports Style mode (validation, repository, API)

**Files:**
- Modify: `lib/validation/job.ts`
- Modify: `db/repositories/jobs.ts`
- Modify: `app/api/jobs/route.ts`
- Test: `tests/lib/validation/job.test.ts`, `tests/db/repositories/jobs.test.ts` (extend both)

**Interfaces:**
- Consumes: `StyleConfigSchema`, `getStyleById` (Task 2).
- Produces: `validateJobInput` now accepts `pacing?: string` and `styleId?: string` (exactly one required); `createJob` now accepts `styleId?: string` and `inspirationImage?: { storageKey: string }` — used by Task 5's UI and Task 6/7's director (which reads `jobs.styleId`).

- [ ] **Step 1: Write the failing validation tests**

Add to `tests/lib/validation/job.test.ts` (the `validInput` fixture keeps its `pacing: 'medium'`; add these new cases):

```typescript
it('accepts a styleId in place of pacing', () => {
  const { pacing, ...withoutPacing } = validInput;
  const errors = validateJobInput({ ...withoutPacing, styleId: '11111111-1111-1111-1111-111111111111' });
  expect(errors).toEqual([]);
});

it('rejects providing both pacing and a styleId', () => {
  const errors = validateJobInput({ ...validInput, styleId: '11111111-1111-1111-1111-111111111111' });
  expect(errors).toContainEqual({
    field: 'mode',
    message: 'Choose either a pacing (Custom mode) or a style (Style mode), not both or neither.',
  });
});

it('rejects providing neither pacing nor a styleId', () => {
  const { pacing, ...withoutPacing } = validInput;
  const errors = validateJobInput({ ...withoutPacing });
  expect(errors).toContainEqual({
    field: 'mode',
    message: 'Choose either a pacing (Custom mode) or a style (Style mode), not both or neither.',
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/lib/validation/job.test.ts`
Expected: FAIL — `validateJobInput`'s current signature requires `pacing` and has no mode check.

- [ ] **Step 3: Update `lib/validation/job.ts`**

```typescript
export const ALLOWED_LENGTHS = [15, 30, 45, 60] as const;
export const ALLOWED_PACINGS = ['slow', 'medium', 'fast'] as const;
export const MAX_VARIATION_COUNT = 20;

export type JobValidationError = { field: string; message: string };

export function validateJobInput(input: {
  productName: string;
  lengthSeconds: number;
  pacing?: string;
  styleId?: string;
  variationCount: number;
  sizingOverlayEnabled: boolean;
  sizeWorn?: string;
  clipCount: number;
}): JobValidationError[] {
  const errors: JobValidationError[] = [];

  if (typeof input.productName !== 'string' || !input.productName.trim()) {
    errors.push({ field: 'productName', message: 'Product name is required.' });
  }
  if (!ALLOWED_LENGTHS.includes(input.lengthSeconds as (typeof ALLOWED_LENGTHS)[number])) {
    errors.push({ field: 'lengthSeconds', message: 'Length must be 15, 30, 45, or 60 seconds.' });
  }

  const hasPacing = typeof input.pacing === 'string' && input.pacing.length > 0;
  const hasStyleId = typeof input.styleId === 'string' && input.styleId.length > 0;
  if (hasPacing === hasStyleId) {
    errors.push({
      field: 'mode',
      message: 'Choose either a pacing (Custom mode) or a style (Style mode), not both or neither.',
    });
  } else if (hasPacing && !ALLOWED_PACINGS.includes(input.pacing as (typeof ALLOWED_PACINGS)[number])) {
    errors.push({ field: 'pacing', message: 'Pacing must be slow, medium, or fast.' });
  }

  if (
    typeof input.variationCount !== 'number' ||
    Number.isNaN(input.variationCount) ||
    input.variationCount < 1 ||
    input.variationCount > MAX_VARIATION_COUNT
  ) {
    errors.push({
      field: 'variationCount',
      message: `Variation count must be between 1 and ${MAX_VARIATION_COUNT}.`,
    });
  }
  if (
    input.sizingOverlayEnabled &&
    (typeof input.sizeWorn !== 'string' || !input.sizeWorn.trim())
  ) {
    errors.push({ field: 'sizeWorn', message: 'Size worn is required when sizing info is enabled.' });
  }
  if (input.clipCount < 1) {
    errors.push({ field: 'clips', message: 'At least one raw clip is required.' });
  }

  return errors;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/lib/validation/job.test.ts`
Expected: PASS (including every pre-existing test in the file, unchanged).

- [ ] **Step 5: Write the failing repository test**

Add to `tests/db/repositories/jobs.test.ts`:

```typescript
import { styles, jobInspirationImages } from '@/db/schema';

// ...

describe('createJob with a style', () => {
  const CLERK_ID = 'test_clerk_user_jobs_style';
  let styleId: string;

  beforeEach(async () => {
    const [style] = await db
      .insert(styles)
      .values({
        name: 'Test Repo Job Style',
        description: 'For repository tests',
        config: {
          cutMinSeconds: 2,
          cutMaxSeconds: 5,
          hookStyleLibrary: ['x'],
          variesClipOrder: true,
          usesInspirationOverlay: true,
        },
      })
      .returning();
    styleId = style.id;
  });

  it('creates a job with a styleId and no pacing, plus an inspiration image', async () => {
    const creator = await createCreatorIfNotExists(CLERK_ID);
    const job = await createJob({
      creatorId: creator.id,
      productName: 'Styled Product',
      sizingOverlayEnabled: false,
      lengthSeconds: 30,
      styleId,
      variationCount: 3,
      clips: [],
      inspirationImage: { storageKey: 'inspiration/test.jpg' },
    });

    expect(job.pacing).toBeNull();
    expect(job.styleId).toBe(styleId);

    const [image] = await db
      .select()
      .from(jobInspirationImages)
      .where(eq(jobInspirationImages.jobId, job.id));
    expect(image.storageKey).toBe('inspiration/test.jpg');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- tests/db/repositories/jobs.test.ts`
Expected: FAIL — `createJob` does not accept `styleId` or `inspirationImage` yet, and `pacing` is currently required.

- [ ] **Step 7: Update `db/repositories/jobs.ts`**

```typescript
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, rawClips, jobInspirationImages } from '@/db/schema';

export type CreateJobInput = {
  creatorId: string;
  productName: string;
  sizeWorn?: string;
  sizingOverlayEnabled: boolean;
  lengthSeconds: 15 | 30 | 45 | 60;
  pacing?: 'slow' | 'medium' | 'fast';
  styleId?: string;
  variationCount: number;
  clips: { storageKey: string; originalFilename: string }[];
  inspirationImage?: { storageKey: string };
};

export async function createJob(input: CreateJobInput) {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .insert(jobs)
      .values({
        creatorId: input.creatorId,
        productName: input.productName,
        sizeWorn: input.sizeWorn,
        sizingOverlayEnabled: input.sizingOverlayEnabled,
        lengthSeconds: input.lengthSeconds,
        pacing: input.pacing,
        styleId: input.styleId,
        variationCount: input.variationCount,
      })
      .returning();

    if (input.clips.length > 0) {
      await tx.insert(rawClips).values(
        input.clips.map((clip) => ({
          jobId: job.id,
          storageKey: clip.storageKey,
          originalFilename: clip.originalFilename,
        }))
      );
    }

    if (input.inspirationImage) {
      await tx.insert(jobInspirationImages).values({
        jobId: job.id,
        storageKey: input.inspirationImage.storageKey,
      });
    }

    return job;
  });
}

export async function listJobsForCreator(creatorId: string) {
  return db.query.jobs.findMany({
    where: eq(jobs.creatorId, creatorId),
    orderBy: desc(jobs.createdAt),
  });
}

export async function getJobForCreator(jobId: string, creatorId: string) {
  return db.query.jobs.findFirst({
    where: and(eq(jobs.id, jobId), eq(jobs.creatorId, creatorId)),
  });
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- tests/db/repositories/jobs.test.ts`
Expected: PASS

- [ ] **Step 9: Update `app/api/jobs/route.ts`**

```typescript
import { auth } from '@clerk/nextjs/server';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob, listJobsForCreator } from '@/db/repositories/jobs';
import { getStyleById } from '@/db/repositories/styles';
import { validateJobInput } from '@/lib/validation/job';
import { StyleConfigSchema } from '@/lib/styles';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const creator = await createCreatorIfNotExists(userId);

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { errors: [{ field: 'form', message: 'Request body must be valid JSON.' }] },
      { status: 400 }
    );
  }

  const pacing = typeof body.pacing === 'string' ? body.pacing : undefined;
  const styleId = typeof body.styleId === 'string' && body.styleId ? body.styleId : undefined;

  const errors = validateJobInput({
    productName: body.productName ?? '',
    lengthSeconds: body.lengthSeconds,
    pacing,
    styleId,
    variationCount: body.variationCount,
    sizingOverlayEnabled: Boolean(body.sizingOverlayEnabled),
    sizeWorn: body.sizeWorn,
    clipCount: Array.isArray(body.clips) ? body.clips.length : 0,
  });

  const clips: unknown[] = Array.isArray(body.clips) ? body.clips : [];
  const hasInvalidClip = clips.some(
    (clip: any) =>
      !clip ||
      typeof clip.storageKey !== 'string' ||
      !clip.storageKey.trim() ||
      typeof clip.originalFilename !== 'string' ||
      !clip.originalFilename.trim()
  );
  if (hasInvalidClip) {
    errors.push({
      field: 'clips',
      message: 'Each clip must have a storage key and an original filename.',
    });
  }

  // A named style must actually exist, and its own config decides whether an
  // inspiration photo is required — never trust the client's word on either.
  let style: Awaited<ReturnType<typeof getStyleById>> | undefined;
  if (styleId) {
    style = await getStyleById(styleId);
    if (!style) {
      errors.push({ field: 'styleId', message: 'Selected style does not exist.' });
    }
  }

  const inspirationImage = body.inspirationImage;
  const hasInspirationImage = Boolean(
    inspirationImage &&
      typeof inspirationImage.storageKey === 'string' &&
      inspirationImage.storageKey.trim()
  );
  if (style) {
    const parsedConfig = StyleConfigSchema.safeParse(style.config);
    if (parsedConfig.success && parsedConfig.data.usesInspirationOverlay && !hasInspirationImage) {
      errors.push({
        field: 'inspirationImage',
        message: 'This style requires an inspiration photo upload.',
      });
    }
  }

  if (errors.length > 0) {
    return Response.json({ errors }, { status: 400 });
  }

  const job = await createJob({
    creatorId: creator.id,
    productName: body.productName,
    sizeWorn: body.sizeWorn,
    sizingOverlayEnabled: Boolean(body.sizingOverlayEnabled),
    lengthSeconds: body.lengthSeconds,
    pacing: pacing as 'slow' | 'medium' | 'fast' | undefined,
    styleId: style?.id,
    variationCount: body.variationCount,
    clips: body.clips,
    inspirationImage: hasInspirationImage ? { storageKey: inspirationImage.storageKey } : undefined,
  });

  return Response.json(job, { status: 201 });
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const creator = await createCreatorIfNotExists(userId);

  const jobs = await listJobsForCreator(creator.id);
  return Response.json(jobs);
}
```

- [ ] **Step 10: Manually verify the route**

This codebase has no route-handler test for `app/api/jobs/route.ts` (job creation is tested through `validateJobInput` and `createJob` directly, which Steps 1-8 already cover) — matches the existing convention, so no new test file here. Confirm with a quick manual check once Task 5's UI exists (folded into Task 10's end-to-end pass).

- [ ] **Step 11: Commit**

```bash
git add lib/validation/job.ts db/repositories/jobs.ts app/api/jobs/route.ts tests/lib/validation/job.test.ts tests/db/repositories/jobs.test.ts
git commit -m "feat: support style-mode job creation alongside custom pacing"
```

---

## Task 4: GET /api/styles — list styles for the gallery

**Files:**
- Create: `app/api/styles/route.ts`

**Interfaces:**
- Consumes: `listStyles` (Task 2).
- Produces: `GET /api/styles` → `{ id, name, description, usesInspirationOverlay }[]` — used by Task 5's UI.

- [ ] **Step 1: Write `app/api/styles/route.ts`**

No new test file: this is a thin read-only wrapper around `listStyles` (already tested in Task 2) with the same auth check every other route in this codebase uses, matching the existing convention of not adding a route-handler test for thin wrappers (`app/api/uploads/presign/route.ts` has none either).

```typescript
import { auth } from '@clerk/nextjs/server';
import { listStyles } from '@/db/repositories/styles';
import { StyleConfigSchema } from '@/lib/styles';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const styles = await listStyles();
  return Response.json(
    styles.map((style) => {
      const parsed = StyleConfigSchema.safeParse(style.config);
      return {
        id: style.id,
        name: style.name,
        description: style.description,
        usesInspirationOverlay: parsed.success ? parsed.data.usesInspirationOverlay : false,
      };
    })
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/styles/route.ts
git commit -m "feat: add GET /api/styles for the style gallery"
```

---

## Task 5: Job creation UI — Custom vs Style mode

**Files:**
- Modify: `app/jobs/new/page.tsx`

**Interfaces:**
- Consumes: `GET /api/styles` (Task 4), `POST /api/uploads/presign` (existing), `POST /api/jobs` (Task 3).
- Produces: a working two-mode job creation form — the deliverable this whole feature exists for.

- [ ] **Step 1: Rewrite `app/jobs/new/page.tsx`**

No new automated test: this codebase has no test file for `app/jobs/new/page.tsx` today (client-page UI is verified manually, matching every prior stage's "end-to-end" task). Verify with the `run` skill in Step 2 below.

```typescript
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type Style = { id: string; name: string; description: string; usesInspirationOverlay: boolean };

export default function NewJobPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'custom' | 'style'>('custom');
  const [styles, setStyles] = useState<Style[]>([]);
  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(null);
  const [inspirationFile, setInspirationFile] = useState<File | null>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [productName, setProductName] = useState('');
  const [sizingOn, setSizingOn] = useState(false);
  const [sizeWorn, setSizeWorn] = useState('');
  const [lengthSeconds, setLengthSeconds] = useState(30);
  const [pacing, setPacing] = useState<'slow' | 'medium' | 'fast'>('medium');
  const [variationCount, setVariationCount] = useState(5);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/styles')
      .then((res) => res.json())
      .then((data: Style[]) => setStyles(data))
      .catch(() => setStyles([]));
  }, []);

  const selectedStyle = styles.find((s) => s.id === selectedStyleId) ?? null;

  async function uploadFile(file: File): Promise<{ storageKey: string; originalFilename: string }> {
    const presignRes = await fetch('/api/uploads/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, contentType: file.type }),
    });
    if (!presignRes.ok) {
      throw new Error(`Failed to get an upload URL for "${file.name}".`);
    }
    const { url, storageKey } = await presignRes.json();

    const uploadRes = await fetch(url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type },
    });
    if (!uploadRes.ok) {
      throw new Error(`Failed to upload "${file.name}". Please try again.`);
    }

    return { storageKey, originalFilename: file.name };
  }

  async function handleSubmit() {
    setSubmitting(true);
    setErrors([]);

    try {
      const clips = [];
      for (const file of files) {
        clips.push(await uploadFile(file));
      }

      let inspirationImage: { storageKey: string } | undefined;
      if (mode === 'style' && selectedStyle?.usesInspirationOverlay && inspirationFile) {
        const uploaded = await uploadFile(inspirationFile);
        inspirationImage = { storageKey: uploaded.storageKey };
      }

      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName,
          sizingOverlayEnabled: sizingOn,
          sizeWorn: sizingOn ? sizeWorn : undefined,
          lengthSeconds,
          pacing: mode === 'custom' ? pacing : undefined,
          styleId: mode === 'style' ? selectedStyleId : undefined,
          variationCount,
          clips,
          inspirationImage,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        setErrors(body.errors ?? [{ field: 'form', message: 'Something went wrong.' }]);
        setSubmitting(false);
        return;
      }

      router.push('/jobs');
    } catch (err) {
      setErrors([
        { field: 'form', message: err instanceof Error ? err.message : 'Something went wrong.' },
      ]);
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>New Video</h1>

      <label>
        Raw clips
        <input
          type="file"
          multiple
          accept="video/*"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
      </label>

      <label>
        Product name
        <input value={productName} onChange={(e) => setProductName(e.target.value)} />
      </label>

      <label>
        <input type="checkbox" checked={sizingOn} onChange={(e) => setSizingOn(e.target.checked)} />
        Show sizing info
      </label>

      {sizingOn && (
        <label>
          Size worn
          <input value={sizeWorn} onChange={(e) => setSizeWorn(e.target.value)} />
        </label>
      )}

      <label>
        Length
        <select value={lengthSeconds} onChange={(e) => setLengthSeconds(Number(e.target.value))}>
          <option value={15}>15s</option>
          <option value={30}>30s</option>
          <option value={45}>45s</option>
          <option value={60}>60s</option>
        </select>
      </label>

      <fieldset>
        <legend>How do you want to edit this?</legend>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'custom'}
            onChange={() => setMode('custom')}
          />
          Custom
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'style'}
            onChange={() => setMode('style')}
          />
          Style
        </label>
      </fieldset>

      {mode === 'custom' && (
        <label>
          Pacing
          <select value={pacing} onChange={(e) => setPacing(e.target.value as typeof pacing)}>
            <option value="slow">Slow</option>
            <option value="medium">Medium</option>
            <option value="fast">Fast</option>
          </select>
        </label>
      )}

      {mode === 'style' && (
        <div>
          {styles.map((style) => (
            <label key={style.id} style={{ display: 'block' }}>
              <input
                type="radio"
                name="style"
                checked={selectedStyleId === style.id}
                onChange={() => setSelectedStyleId(style.id)}
              />
              <strong>{style.name}</strong> — {style.description}
            </label>
          ))}

          {selectedStyle?.usesInspirationOverlay && (
            <label>
              Inspiration photo
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setInspirationFile(e.target.files?.[0] ?? null)}
              />
            </label>
          )}
        </div>
      )}

      <label>
        Variations
        <input
          type="number"
          min={1}
          max={20}
          value={variationCount}
          onChange={(e) => setVariationCount(Number(e.target.value))}
        />
      </label>

      <button onClick={handleSubmit} disabled={submitting}>
        {submitting ? 'Creating...' : 'Create'}
      </button>

      {errors.map((err) => (
        <p key={err.field} style={{ color: 'red' }}>
          {err.message}
        </p>
      ))}
    </main>
  );
}
```

- [ ] **Step 2: Manually verify in the browser**

Use the `run` skill to start the dev server, sign in, go to `/jobs/new`, and confirm:
- Custom mode looks and behaves exactly as before.
- Style mode shows the two seeded style cards with their descriptions, hides the pacing dropdown, and — only for "Dupe Flip" — shows an inspiration-photo upload field.
- Submitting a Style-mode job with clips actually creates the job (`/jobs` shows it).

- [ ] **Step 3: Commit**

```bash
git add app/jobs/new/page.tsx
git commit -m "feat: add Custom/Style mode toggle and style gallery to job creation"
```

---

## Task 6: Director — style-driven cut band, hook library, and pinned sizing placement

**Files:**
- Modify: `lib/pipeline/director.ts`
- Test: `tests/lib/pipeline/director.test.ts` (extend)

**Interfaces:**
- Consumes: `styles` table, `StyleConfigSchema` (Task 2), `jobs.styleId` (Task 1).
- Produces: `planJob` now resolves cut band / hook library / sizing placement from the job's style when `styleId` is set, and from `pacing` otherwise. `EffectivePreset` type and `resolvePreset` function — consumed by Task 7 in the same file.

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/pipeline/director.test.ts` (needs `styles` imported from `@/db/schema`):

```typescript
import { styles } from '@/db/schema';

describe('style mode', () => {
  const CLERK_ID = 'test_clerk_user_director_style';
  let styleCreatorId: string;
  let dupeFlipStyleId: string;

  beforeEach(async () => {
    const creator = await createCreatorIfNotExists(CLERK_ID);
    styleCreatorId = creator.id;

    const [style] = await db
      .insert(styles)
      .values({
        name: 'Test Dupe Flip',
        description: 'test',
        config: {
          cutMinSeconds: 2,
          cutMaxSeconds: 3,
          hookStyleLibrary: ['Affordable Designer Alternatives..'],
          sizingPlacement: 'bottom-left',
          variesClipOrder: false,
          usesInspirationOverlay: false,
        },
      })
      .returning();
    dupeFlipStyleId = style.id;
  });

  async function createStyleJob() {
    const job = await createJob({
      creatorId: styleCreatorId,
      productName: 'Denim',
      sizingOverlayEnabled: true,
      sizeWorn: 'M',
      lengthSeconds: 15,
      styleId: dupeFlipStyleId,
      variationCount: 1,
      clips: [{ storageKey: 'clips/denim.mp4', originalFilename: 'denim.mp4' }],
    });
    const [clip] = await db.select().from(rawClips).where(eq(rawClips.jobId, job.id));
    await db.insert(segments).values([
      { rawClipId: clip.id, startSeconds: '0', endSeconds: '15', contentTag: 'whole-clip', qualityTag: 'high' },
    ]);
    await db
      .update(creators)
      .set({ height: '5\'6"', weight: '140 lb' })
      .where(eq(creators.id, styleCreatorId));
    return { jobId: job.id, clipId: clip.id };
  }

  it("uses the style's cut band instead of a named pacing preset", async () => {
    const { jobId, clipId } = await createStyleJob();
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        {
          // Every cut inside the style's 2-3s band (widened 25% to 1.5-3.75s), 15s total.
          segments: [
            { rawClipId: clipId, startSeconds: 0, endSeconds: 3 },
            { rawClipId: clipId, startSeconds: 4, endSeconds: 7 },
            { rawClipId: clipId, startSeconds: 8, endSeconds: 11 },
            { rawClipId: clipId, startSeconds: 12, endSeconds: 15 },
          ],
          hookText: 'Affordable finds for the win',
          sizingOverlayText: 'For reference',
          sizingOverlayPlacement: 'bottom-left',
        },
      ])
    );

    const result = await planJob(jobId);

    expect(result).toEqual({ success: true, variationCount: 1, warning: null });
    expect(promptTextOfCall(0)).toContain('between 1.5 and 3.75 seconds');
    expect(promptTextOfCall(0)).toContain('Affordable Designer Alternatives..');
  });

  it("rejects a cut outside the style's band even though it would fit a named preset", async () => {
    const { jobId, clipId } = await createStyleJob();
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        {
          // 8s single cut: inside "medium" pacing's band, but nowhere near this style's 1.5-3.75s band.
          segments: [{ rawClipId: clipId, startSeconds: 0, endSeconds: 8 }],
          hookText: 'Affordable finds for the win',
          sizingOverlayText: null,
          sizingOverlayPlacement: null,
        },
      ])
    );

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
  });

  it('forces the sizing placement the style pins, ignoring whatever the model returns', async () => {
    const { jobId, clipId } = await createStyleJob();
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        {
          segments: [
            { rawClipId: clipId, startSeconds: 0, endSeconds: 3 },
            { rawClipId: clipId, startSeconds: 4, endSeconds: 7 },
            { rawClipId: clipId, startSeconds: 8, endSeconds: 11 },
            { rawClipId: clipId, startSeconds: 12, endSeconds: 15 },
          ],
          hookText: 'Affordable finds for the win',
          sizingOverlayText: 'For reference',
          // The model tries to put it top-right; the style pins bottom-left.
          sizingOverlayPlacement: 'top-right',
        },
      ])
    );

    await planJob(jobId);

    const [saved] = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved.sizingOverlayPlacement).toBe('bottom-left');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/lib/pipeline/director.test.ts`
Expected: FAIL — `planJob` still reads `job.pacing` and the global `HOOK_STYLE_LIBRARY` unconditionally, and `PACING_PRESET_SECONDS[job.pacing]` throws on a null pacing.

- [ ] **Step 3: Update `lib/pipeline/director.ts`**

Import `styles` and the style config schema:

```typescript
// director.ts — add to the existing imports
import { jobs, rawClips, segments, editPlans, creators, styles } from '@/db/schema';
import { StyleConfigSchema, type StyleConfig } from '@/lib/styles';
```

Fix the `PACING_PRESET_SECONDS` type (the `pacing` column is now nullable, so `Job['pacing']` includes `null`, which cannot key a `Record`):

```typescript
// director.ts:104 — change the type parameter
const PACING_PRESET_SECONDS: Record<NonNullable<Job['pacing']>, { min: number; max: number }> = {
  slow: { min: 5, max: 6 },
  medium: { min: 3, max: 4 },
  fast: { min: 1, max: 2 },
};
```

Replace `bandFor` (director.ts:337-344) with a preset-based version, and add the `EffectivePreset` type and `resolvePreset`:

```typescript
type StyleRow = typeof styles.$inferSelect;

/**
 * Everything the prompt and validator need, resolved uniformly from either a
 * named pacing preset (Custom mode) or a style's config (Style mode) — every
 * later rule reads this instead of branching on `job.pacing` vs `job.styleId`.
 */
type EffectivePreset = {
  /** The "ideal" per-cut range named in the prompt, before pacing tolerance widens it. */
  ideal: { min: number; max: number };
  /** Reads naturally in "${label} means every cut must be between...". */
  label: string;
  hookStyleLibrary: readonly string[];
  /** Non-null when the style pins one corner for every variation. */
  sizingPlacementOverride: (typeof OVERLAY_PLACEMENTS)[number] | null;
  variesClipOrder: boolean;
};

/**
 * Resolves the job's editing preset. `style` is defined exactly when
 * `job.styleId` is set — see the lookup in `planJob`.
 */
function resolvePreset(job: Job, style: StyleRow | undefined): EffectivePreset {
  if (style) {
    // The style's config was already zod-validated when it was fetched in
    // planJob; a malformed style row fails the job before this is ever called.
    const config = style.config as StyleConfig;
    return {
      ideal: { min: config.cutMinSeconds, max: config.cutMaxSeconds },
      label: `the "${style.name}" style`,
      hookStyleLibrary: config.hookStyleLibrary,
      sizingPlacementOverride: config.sizingPlacement ?? null,
      variesClipOrder: config.variesClipOrder,
    };
  }
  return {
    ideal: PACING_PRESET_SECONDS[job.pacing!],
    label: `"${job.pacing}" pacing`,
    hookStyleLibrary: HOOK_STYLE_LIBRARY,
    sizingPlacementOverride: null,
    variesClipOrder: false,
  };
}

/** Widest allowed length for one cut, from either preset source. */
function bandForPreset(ideal: { min: number; max: number }): PacingBand {
  return {
    min: ideal.min * (1 - PACING_TOLERANCE),
    max: ideal.max * (1 + PACING_TOLERANCE),
  };
}
```

Update `ValidationContext` (director.ts:298-306) to carry a label instead of the raw pacing enum:

```typescript
type ValidationContext = {
  expectedVariationCount: number;
  targetLengthSeconds: number;
  footageEndByClipId: Map<string, number>;
  sizingOverlayEnabled: boolean;
  footage: PoolCapacity;
  pacingLabel: string;
  pacingBand: PacingBand;
};
```

Update `buildValidator`'s destructuring (director.ts:597-606) and its two message sites (director.ts:751-753 and 761-763):

```typescript
function buildValidator(context: ValidationContext) {
  const {
    expectedVariationCount,
    targetLengthSeconds,
    footageEndByClipId,
    sizingOverlayEnabled,
    footage,
    pacingLabel,
    pacingBand,
  } = context;

  // ...unchanged body, except the two pacing-band issue messages:

  if (duration > pacingBand.max + 1e-9) {
    ctx.addIssue({
      code: 'custom',
      path,
      message:
        `this cut is ${round2(duration)}s long, but ${pacingLabel} means every cut must ` +
        `be between ${round2(pacingBand.min)}s and ${round2(pacingBand.max)}s. Split this ` +
        `footage into shorter cuts and place them at different points in the video instead ` +
        `of using it as one long take`,
    });
  } else if (floorApplies && duration < floor - 1e-9) {
    ctx.addIssue({
      code: 'custom',
      path,
      message:
        `this cut is only ${round2(duration)}s long, but ${pacingLabel} means every cut ` +
        `must be between ${round2(pacingBand.min)}s and ${round2(pacingBand.max)}s` +
        (isFinalCut
          ? ` (the final cut of a variation may go as low as ${round2(floor)}s)`
          : ''),
    });
  }
}
```

Update `buildPrompt` (director.ts:920-1034) to take the resolved preset instead of reading `job.pacing`/`HOOK_STYLE_LIBRARY` directly:

```typescript
function buildPrompt(
  job: Job,
  segmentPool: PoolSegment[],
  footage: PoolCapacity,
  band: PacingBand,
  preset: EffectivePreset,
  correctionNote?: string
): string {
  const placements = OVERLAY_PLACEMENTS.map((p) => `"${p}"`).join(', ');
  const sizingInstruction = job.sizingOverlayEnabled
    ? `This ad shows a sizing overlay. The creator's real height and weight are appended automatically from their stored profile${
        job.sizeWorn ? `, along with the size worn: ${job.sizeWorn}` : ''
      }. So write sizingOverlayText as a short lead-in phrase ONLY (for example "For reference" or "Fit check") and never write any height, weight, or size numbers yourself - you do not know them and inventing them is not acceptable. ${
        preset.sizingPlacementOverride
          ? `Set sizingOverlayPlacement to "${preset.sizingPlacementOverride}" for every variation - this style always places it there.`
          : `Set sizingOverlayPlacement to one of: ${placements}.`
      }`
    : 'Set sizingOverlayText and sizingOverlayPlacement to null.';

  const durationFloor = round2(job.lengthSeconds * (1 - DURATION_UNDER_TOLERANCE));
  const durationCeiling = round2(job.lengthSeconds * (1 + DURATION_OVER_TOLERANCE));
  const aimFloor = round2(job.lengthSeconds * (1 - DURATION_AIM_TOLERANCE));
  const aimCeiling = round2(job.lengthSeconds * (1 + DURATION_AIM_TOLERANCE));
  const durationInstruction = footage.isSufficient
    ? `TOTAL LENGTH: AIM FOR ${job.lengthSeconds} SECONDS.
Add up your cut durations: every variation should land between ${aimFloor}s and ${aimCeiling}s.
A total below ${durationFloor}s or above ${durationCeiling}s is rejected outright, but do not aim for ${durationFloor}s -
the creator asked for ${job.lengthSeconds}s, and a variation that stops short is a worse edit, not a safer one.
If your total is under ${aimFloor}s, add another cut before you answer.`
    : `There is only ${round2(footage.availableSeconds)}s of distinct footage in the pool, which cannot fill the
${job.lengthSeconds}s target within the reuse limit below. Do NOT pad the video by repeating segments.
Aim instead for a total of about ${round2(footage.maxAchievableSeconds)}s per variation - a shorter video is
much better than a repetitive one.`;

  const approximateCuts = Math.max(
    2,
    Math.round(job.lengthSeconds / ((preset.ideal.min + preset.ideal.max) / 2))
  );
  const pacingInstruction = `PACING IS THE MOST IMPORTANT RULE. ${preset.label} means every single cut
must last between ${round2(band.min)} and ${round2(band.max)} seconds, ideally around ${preset.ideal.min}-${preset.ideal.max} seconds.
A ${job.lengthSeconds}s video at this pacing is roughly ${approximateCuts} cuts, not a handful of long takes. A cut longer than
${round2(band.max)}s will be rejected: one unbroken shot destroys the fast-cut feel this format depends on.
Only the FINAL cut of a variation may be shorter than ${round2(band.min)}s (down to ${round2(
    band.min * FINAL_CUT_FLOOR_RATIO
  )}s) if you need it to land on the target length.

A listed segment is a RANGE YOU MAY CUT INSIDE, not a fixed block: you choose any startSeconds and
endSeconds you like within a clip's listed footage. So when a good segment is longer than ${round2(band.max)}s,
SPLIT IT into several shorter cuts and place them at DIFFERENT POINTS in the video rather than using it
as one long take. An 8s segment becomes, for example, a cut early in the video and a separate,
non-overlapping cut later on. This is how you reach ${approximateCuts} cuts from a handful of long clips.`;

  const visibleCutInstruction = `EVERY CUT MUST BE VISIBLE. Splitting a clip is only a cut if footage is thrown away at the
splice. If two cuts NEXT TO EACH OTHER in the sequence come from the same clip, they must not be
chronologically adjacent: leave at least ${MIN_CUT_GAP_SECONDS}s of footage OUT between them, or make the second cut
jump BACKWARDS to an earlier part of the clip.
  WRONG: 0-4 then 4-8 then 8-12 from one clip. That is the original take playing straight through -
  the viewer sees no cut at all, and it will be rejected however many "cuts" you list.
  RIGHT: 0-4 then 5-9 then 10-14 (a second of footage discarded at each splice), or 0-4 then 12-16
  then 6-10 (out of order), or interleave a different clip between them.
A ${MIN_CUT_GAP_SECONDS}s gap costs you almost nothing and is what makes the edit read as edited.`;

  const distinctnessInstruction =
    job.variationCount > 1
      ? `THE ${job.variationCount} VARIATIONS MUST BE STRUCTURALLY DIFFERENT EDITS, not one edit with different hook text.
Each variation must differ from the one before it in ALL of these ways:
- a different OPENING shot (a different moment, not the same shot re-trimmed);
- a different ORDER (do not reuse one skeleton with a single clip swapped out);
- different SUBDIVISION BOUNDARIES (if variation 1 splits a clip 0-4 / 8-12, variation 2 should
  split it somewhere else, e.g. 2-6 / 13-17), and a different number of cuts where the length allows.
Two neighbouring variations that match in every position but one will be rejected.`
      : '';

  return `You are editing a short-form UGC ad video for the product "${job.productName}".
Target length: ${job.lengthSeconds} seconds. Editing style: ${preset.label}.
Produce exactly ${job.variationCount} distinct variations.

Available segments (choose from these only, by rawClipId):
${JSON.stringify(segmentPool)}

${pacingInstruction}

${visibleCutInstruction}

${durationInstruction}
${distinctnessInstruction}
If there are not enough distinct good segments to reach the target length, you may reuse a moment,
but never in two consecutive positions in the sequence and never more than ${MAX_SEGMENT_REUSE} times in
the same variation. Two cuts count as the SAME moment when they come from the same clip and overlap by
more than half of the shorter one - so nudging a boundary (0-8 then 0.1-8) is still a repeat, while two
non-overlapping cuts from one clip are different footage and are exactly what you should be doing,
provided they obey the visible-cut rule above when they sit next to each other.
If you ever have to choose between padding a variation and letting it run short, let it run short.
Never reference a rawClipId that is not listed above, and never let endSeconds run past
the end of that clip's listed footage.

Hook text should be adapted from this style library to fit the product (not copied verbatim):
${JSON.stringify(preset.hookStyleLibrary)}
Write hookText as ONE short on-screen line, under ${MAX_HOOK_LENGTH} characters. It must never contain a
height, weight or size measurement - you do not know the creator's real numbers, and inventing them
would print made-up body stats on a real person's published video.

${sizingInstruction}
${correctionNote ? `\nYour previous response was invalid: ${correctionNote}\nPlease fix it.\n` : ''}
Respond with JSON only, matching this shape:
{"variations": [{"segments": [{"rawClipId": string, "startSeconds": number, "endSeconds": number}], "hookText": string, "sizingOverlayText": string | null, "sizingOverlayPlacement": string | null}]}`;
}
```

Update `planJob` (director.ts:1037 onward) to look up the style, resolve the preset, and force the pinned sizing placement:

```typescript
// planJob — right after `const { job, creator } = row;`
const style = job.styleId
  ? (await db.select().from(styles).where(eq(styles.id, job.styleId)))[0]
  : undefined;
if (job.styleId && !style) {
  return { success: false, error: `Style ${job.styleId} referenced by job ${jobId} was not found` };
}
if (style) {
  const parsedConfig = StyleConfigSchema.safeParse(style.config);
  if (!parsedConfig.success) {
    return { success: false, error: `Style ${style.id} has an invalid config: ${parsedConfig.error.message}` };
  }
}

// ...after segmentPool/footageEndByClipId are built, replace:
//   const band = bandFor(job.pacing);
// with:
const preset = resolvePreset(job, style);
const band = bandForPreset(preset.ideal);

// ...replace the buildValidator call's `pacing: job.pacing` with:
const validator = buildValidator({
  expectedVariationCount: job.variationCount,
  targetLengthSeconds: job.lengthSeconds,
  footageEndByClipId,
  sizingOverlayEnabled: job.sizingOverlayEnabled,
  footage,
  pacingLabel: preset.label,
  pacingBand: band,
});

// ...inside the retry loop, replace the buildPrompt call:
parts: [{ text: buildPrompt(job, segmentPool, footage, band, preset, correctionNote) }],
```

Finally, force the pinned sizing placement when persisting (director.ts, inside the `editPlans` insert mapping — replace the `sizingOverlayPlacement` line):

```typescript
sizingOverlayPlacement: overlayText
  ? preset.sizingPlacementOverride ?? v.sizingOverlayPlacement
  : null,
```

- [ ] **Step 4: Run the full director test suite to verify everything passes**

Run: `npm test -- tests/lib/pipeline/director.test.ts`
Expected: PASS — every pre-existing Custom-mode test still passes unchanged (the resolved `label` for a `pacing`-only job is byte-identical to the old `"${job.pacing}" pacing` string, and `bandForPreset` produces the same numbers `bandFor` did), plus the three new style-mode tests.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/director.ts tests/lib/pipeline/director.test.ts
git commit -m "feat: director resolves cut band, hook library, and sizing placement from a job's style"
```

---

## Task 7: Director — clip order varies across a job's variations

**Files:**
- Modify: `lib/pipeline/director.ts`
- Test: `tests/lib/pipeline/director.test.ts` (extend)

**Interfaces:**
- Consumes: `EffectivePreset.variesClipOrder` (Task 6), `segments.contentTag` values `'b-roll'` / `'try-on'` (existing, from the tagging step).
- Produces: when a style's `variesClipOrder` is true and the job's tagged footage has both a `b-roll` and a `try-on` segment, each variation is assigned one of `broll-first` / `tryon-first` / `mixed` (cycling by variation index) and the director enforces it.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('style mode', ...)` block in `tests/lib/pipeline/director.test.ts` (needs a style with `variesClipOrder: true` and a pool with both tags):

```typescript
describe('clip order variation', () => {
  let orderedStyleId: string;
  let orderedJobId: string;
  let orderedClipId: string;

  beforeEach(async () => {
    const [style] = await db
      .insert(styles)
      .values({
        name: 'Test Ordered Style',
        description: 'test',
        config: {
          cutMinSeconds: 2,
          cutMaxSeconds: 6,
          hookStyleLibrary: ['Affordable Designer Alternatives..'],
          variesClipOrder: true,
          usesInspirationOverlay: false,
        },
      })
      .returning();
    orderedStyleId = style.id;

    const job = await createJob({
      creatorId: styleCreatorId,
      productName: 'Denim',
      sizingOverlayEnabled: false,
      lengthSeconds: 12,
      styleId: orderedStyleId,
      variationCount: 2,
      clips: [{ storageKey: 'clips/denim.mp4', originalFilename: 'denim.mp4' }],
    });
    orderedJobId = job.id;
    const [clip] = await db.select().from(rawClips).where(eq(rawClips.jobId, job.id));
    orderedClipId = clip.id;
    // 0-6s tagged b-roll, 6-12s tagged try-on: enough of each, non-overlapping,
    // so the ordering rule has something unambiguous to check.
    await db.insert(segments).values([
      { rawClipId: clip.id, startSeconds: '0', endSeconds: '6', contentTag: 'b-roll', qualityTag: 'high' },
      { rawClipId: clip.id, startSeconds: '6', endSeconds: '12', contentTag: 'try-on', qualityTag: 'high' },
    ]);
  });

  function orderedVariation(cuts: { startSeconds: number; endSeconds: number }[], hookText: string) {
    return {
      segments: cuts.map((c) => ({ rawClipId: orderedClipId, ...c })),
      hookText,
      sizingOverlayText: null,
      sizingOverlayPlacement: null,
    };
  }

  it('assigns variation 1 (index 0) the b-roll-first pattern and rejects a try-on-first answer', async () => {
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        // try-on (6-9, 9-12) before b-roll (0-3, 3-6): violates b-roll-first.
        orderedVariation([{ startSeconds: 6, endSeconds: 9 }, { startSeconds: 9, endSeconds: 12 }, { startSeconds: 0, endSeconds: 3 }, { startSeconds: 3, endSeconds: 6 }], 'Hook one'),
        orderedVariation([{ startSeconds: 0, endSeconds: 3 }, { startSeconds: 3, endSeconds: 6 }, { startSeconds: 6, endSeconds: 9 }, { startSeconds: 9, endSeconds: 12 }], 'Hook two'),
      ])
    );

    const result = await planJob(orderedJobId);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('b-roll');
  });

  it('accepts variation 1 with b-roll before try-on and variation 2 with try-on before b-roll', async () => {
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        // Variation 1 (index 0): b-roll-first pattern.
        orderedVariation([{ startSeconds: 0, endSeconds: 3 }, { startSeconds: 3, endSeconds: 6 }, { startSeconds: 6, endSeconds: 9 }, { startSeconds: 9, endSeconds: 12 }], 'Hook one'),
        // Variation 2 (index 1): try-on-first pattern.
        orderedVariation([{ startSeconds: 9, endSeconds: 12 }, { startSeconds: 6, endSeconds: 9 }, { startSeconds: 0, endSeconds: 3 }, { startSeconds: 3, endSeconds: 6 }], 'Hook two'),
      ])
    );

    const result = await planJob(orderedJobId);

    expect(result).toEqual({ success: true, variationCount: 2, warning: null });
  });

  it('tells the model which ordering pattern each variation must follow', async () => {
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        orderedVariation([{ startSeconds: 0, endSeconds: 3 }, { startSeconds: 3, endSeconds: 6 }, { startSeconds: 6, endSeconds: 9 }, { startSeconds: 9, endSeconds: 12 }], 'Hook one'),
        orderedVariation([{ startSeconds: 9, endSeconds: 12 }, { startSeconds: 6, endSeconds: 9 }, { startSeconds: 0, endSeconds: 3 }, { startSeconds: 3, endSeconds: 6 }], 'Hook two'),
      ])
    );

    await planJob(orderedJobId);

    const prompt = promptTextOfCall(0);
    expect(prompt).toContain('CLIP ORDER VARIES BY VARIATION');
    expect(prompt).toContain('Variation 1:');
    expect(prompt).toContain('Variation 2:');
  });

  it('does not constrain ordering when the style leaves it unset', async () => {
    // The Task 6 fixture style (`dupeFlipStyleId`) has variesClipOrder: false.
    const { jobId, clipId } = await createStyleJob();
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        {
          segments: [
            { rawClipId: clipId, startSeconds: 0, endSeconds: 3 },
            { rawClipId: clipId, startSeconds: 4, endSeconds: 7 },
            { rawClipId: clipId, startSeconds: 8, endSeconds: 11 },
            { rawClipId: clipId, startSeconds: 12, endSeconds: 15 },
          ],
          hookText: 'Affordable finds for the win',
          sizingOverlayText: null,
          sizingOverlayPlacement: null,
        },
      ])
    );

    await planJob(jobId);

    expect(promptTextOfCall(0)).not.toContain('CLIP ORDER VARIES BY VARIATION');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/lib/pipeline/director.test.ts`
Expected: FAIL — no ordering instruction or validation exists yet.

- [ ] **Step 3: Update `lib/pipeline/director.ts`**

Add the ordering-pattern helpers (near the top-level helper functions, e.g. right after `bandForPreset`):

```typescript
type OrderPattern = 'broll-first' | 'tryon-first' | 'mixed';
const ORDER_PATTERNS: readonly OrderPattern[] = ['broll-first', 'tryon-first', 'mixed'];

/** Cycles through the three patterns by variation index, so a batch mixes it up. */
function orderPatternsForVariations(count: number): OrderPattern[] {
  return Array.from({ length: count }, (_, i) => ORDER_PATTERNS[i % ORDER_PATTERNS.length]);
}

function orderingRuleText(pattern: OrderPattern): string {
  switch (pattern) {
    case 'broll-first':
      return 'every segment tagged "b-roll" must come before every segment tagged "try-on"';
    case 'tryon-first':
      return 'every segment tagged "try-on" must come before every segment tagged "b-roll"';
    case 'mixed':
      return 'no ordering constraint between "b-roll" and "try-on" segments - arrange them however makes the best edit';
  }
}

/**
 * Which content tag a cut mostly overlaps, ignoring "whole-clip"/"other" (both
 * unconstrained by the ordering rule). A cut whose majority falls outside any
 * b-roll/try-on tagged range is unconstrained too.
 */
function cutContentTag(cut: Cut, taggedPool: PoolSegment[]): 'b-roll' | 'try-on' | null {
  let bestTag: 'b-roll' | 'try-on' | null = null;
  let bestOverlap = 0;
  for (const segment of taggedPool) {
    if (segment.rawClipId !== cut.rawClipId) continue;
    if (segment.contentTag !== 'b-roll' && segment.contentTag !== 'try-on') continue;
    const overlap =
      Math.min(cut.endSeconds, segment.endSeconds) - Math.max(cut.startSeconds, segment.startSeconds);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestTag = segment.contentTag;
    }
  }
  return bestOverlap > cutDuration(cut) / 2 ? bestTag : null;
}
```

Add `taggedPool` and `orderPatterns` to `ValidationContext`:

```typescript
type ValidationContext = {
  expectedVariationCount: number;
  targetLengthSeconds: number;
  footageEndByClipId: Map<string, number>;
  sizingOverlayEnabled: boolean;
  footage: PoolCapacity;
  pacingLabel: string;
  pacingBand: PacingBand;
  taggedPool: PoolSegment[];
  orderPatterns: OrderPattern[] | null;
};
```

Destructure the two new fields in `buildValidator` and add the check inside the existing `value.variations.forEach((variation, variationIndex) => { ... })` loop (append it right after the sizing-overlay-measurement check, before the hook-measurement check):

```typescript
function buildValidator(context: ValidationContext) {
  const {
    expectedVariationCount,
    targetLengthSeconds,
    footageEndByClipId,
    sizingOverlayEnabled,
    footage,
    pacingLabel,
    pacingBand,
    taggedPool,
    orderPatterns,
  } = context;

  return DirectorResponseSchema.superRefine((value, ctx) => {
    // ...unchanged variation-count check...

    value.variations.forEach((variation, variationIndex) => {
      const variationPath = ['variations', variationIndex];

      // ...unchanged duration, reuse-cap, and sizing-measurement checks...

      if (orderPatterns) {
        const pattern = orderPatterns[variationIndex];
        if (pattern !== 'mixed') {
          const requiredFirst = pattern === 'broll-first' ? 'b-roll' : 'try-on';
          const requiredSecond = pattern === 'broll-first' ? 'try-on' : 'b-roll';
          const tags = variation.segments.map((cut) => cutContentTag(cut, taggedPool));
          const lastFirstIndex = tags.lastIndexOf(requiredFirst);
          const firstSecondIndex = tags.indexOf(requiredSecond);
          if (lastFirstIndex !== -1 && firstSecondIndex !== -1 && firstSecondIndex < lastFirstIndex) {
            ctx.addIssue({
              code: 'custom',
              path: [...variationPath, 'segments'],
              message:
                `this style's variation ${variationIndex + 1} must place every "${requiredFirst}" ` +
                `segment before every "${requiredSecond}" segment, but a "${requiredSecond}" segment ` +
                `appears before a later "${requiredFirst}" segment`,
            });
          }
        }
      }

      // ...unchanged hook-measurement check, footage-bounds/pacing/repeat checks...
    });

    // ...unchanged structural-distinctness block...
  });
}
```

Update `planJob` to compute `orderPatterns` and pass the two new context fields:

```typescript
// planJob — after segmentPool is built and before buildValidator is constructed:
const hasBothOrderingTags =
  segmentPool.some((s) => s.contentTag === 'b-roll') && segmentPool.some((s) => s.contentTag === 'try-on');
const orderPatterns =
  preset.variesClipOrder && hasBothOrderingTags ? orderPatternsForVariations(job.variationCount) : null;

const validator = buildValidator({
  expectedVariationCount: job.variationCount,
  targetLengthSeconds: job.lengthSeconds,
  footageEndByClipId,
  sizingOverlayEnabled: job.sizingOverlayEnabled,
  footage,
  pacingLabel: preset.label,
  pacingBand: band,
  taggedPool: segmentPool,
  orderPatterns,
});
```

Update `buildPrompt`'s signature to accept `orderPatterns` and inject the instruction:

```typescript
function buildPrompt(
  job: Job,
  segmentPool: PoolSegment[],
  footage: PoolCapacity,
  band: PacingBand,
  preset: EffectivePreset,
  orderPatterns: OrderPattern[] | null,
  correctionNote?: string
): string {
  // ...unchanged sizingInstruction, durationInstruction, pacingInstruction, visibleCutInstruction...

  const orderingInstruction = orderPatterns
    ? `CLIP ORDER VARIES BY VARIATION. This style alternates the order footage appears in across variations.
For each variation (1-indexed, matching its position in your response array), follow this rule:
${orderPatterns.map((pattern, i) => `- Variation ${i + 1}: ${orderingRuleText(pattern)}`).join('\n')}
Segments tagged "b-roll" or "try-on" are the ones this rule constrains; segments tagged "whole-clip" or "other" may appear anywhere.`
    : '';

  // ...unchanged distinctnessInstruction...

  return `You are editing a short-form UGC ad video for the product "${job.productName}".
Target length: ${job.lengthSeconds} seconds. Editing style: ${preset.label}.
Produce exactly ${job.variationCount} distinct variations.

Available segments (choose from these only, by rawClipId):
${JSON.stringify(segmentPool)}

${pacingInstruction}

${visibleCutInstruction}

${durationInstruction}
${distinctnessInstruction}
${orderingInstruction}
If there are not enough distinct good segments to reach the target length, you may reuse a moment,
but never in two consecutive positions in the sequence and never more than ${MAX_SEGMENT_REUSE} times in
the same variation. Two cuts count as the SAME moment when they come from the same clip and overlap by
more than half of the shorter one - so nudging a boundary (0-8 then 0.1-8) is still a repeat, while two
non-overlapping cuts from one clip are different footage and are exactly what you should be doing,
provided they obey the visible-cut rule above when they sit next to each other.
If you ever have to choose between padding a variation and letting it run short, let it run short.
Never reference a rawClipId that is not listed above, and never let endSeconds run past
the end of that clip's listed footage.

Hook text should be adapted from this style library to fit the product (not copied verbatim):
${JSON.stringify(preset.hookStyleLibrary)}
Write hookText as ONE short on-screen line, under ${MAX_HOOK_LENGTH} characters. It must never contain a
height, weight or size measurement - you do not know the creator's real numbers, and inventing them
would print made-up body stats on a real person's published video.

${sizingInstruction}
${correctionNote ? `\nYour previous response was invalid: ${correctionNote}\nPlease fix it.\n` : ''}
Respond with JSON only, matching this shape:
{"variations": [{"segments": [{"rawClipId": string, "startSeconds": number, "endSeconds": number}], "hookText": string, "sizingOverlayText": string | null, "sizingOverlayPlacement": string | null}]}`;
}
```

Update the two `buildPrompt(...)` call sites inside `planJob`'s retry loop to pass `orderPatterns`:

```typescript
parts: [{ text: buildPrompt(job, segmentPool, footage, band, preset, orderPatterns, correctionNote) }],
```

- [ ] **Step 4: Run the full director test suite to verify everything passes**

Run: `npm test -- tests/lib/pipeline/director.test.ts`
Expected: PASS — every previous test (Custom mode, Task 6's style tests) is unaffected, since `orderPatterns` is `null` whenever a style leaves `variesClipOrder` unset or the pool lacks both tags, and a `null` context value produces no prompt text and no validator check.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/director.ts tests/lib/pipeline/director.test.ts
git commit -m "feat: vary clip ordering across a job's variations for styles that request it"
```

---

## Task 8: Renderer — style text color

**Files:**
- Modify: `lib/render/text.ts`
- Modify: `lib/render/renderPlan.ts`
- Test: `tests/lib/render/text.test.ts`, `tests/lib/render/renderPlan.test.ts` (extend both)

**Interfaces:**
- Consumes: `jobs.styleId`, `styles.config.textColor` (Tasks 1-2).
- Produces: `renderHookLayer`/`renderSizingLayer`/`overlayText` accept an optional `textColor` (hex, default `'#ffffff'`); `renderPlan` resolves it from the job's style.

- [ ] **Step 1: Write the failing test**

Add to `tests/lib/render/text.test.ts`:

```typescript
describe('textColor', () => {
  it('draws in the requested color instead of the default white', async () => {
    const white = await inkOf(renderHookLayer('Fit check').png);
    const colored = await inkOf(renderHookLayer('Fit check', { textColor: '#00ff00' }).png);

    // Same shape (same text, same layout), different pixels: proves the color
    // parameter actually changed what was drawn, not just that something drew.
    expect(colored.count).toBeGreaterThan(0);
    expect(colored.box).toEqual(white.box);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/render/text.test.ts`
Expected: FAIL — `renderHookLayer` doesn't accept a second argument yet.

- [ ] **Step 3: Update `lib/render/text.ts`**

Add an options parameter to `renderLayer`, `renderHookLayer`, `renderSizingLayer`, and `overlayText`:

```typescript
/** Default when a style does not specify its own color. */
const DEFAULT_TEXT_COLOR = '#ffffff';

type LayerOptions = {
  text: string;
  fontSize: number;
  lineHeightRatio: number;
  maxWidth: number;
  align: 'left' | 'center' | 'right';
  x: number;
  y: number | ((blockHeight: number) => number);
  textColor: string;
};

function renderLayer(options: LayerOptions): TextLayer {
  registerFont();

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.font = `${options.fontSize}px "${FONT_FAMILY}"`;
  ctx.textAlign = options.align;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.92)';
  ctx.lineWidth = Math.round(options.fontSize * 0.22);
  ctx.fillStyle = options.textColor;

  const lines = wrap(ctx, options.text, options.maxWidth);
  const lineHeight = Math.round(options.fontSize * options.lineHeightRatio);
  const blockHeight = lines.length * lineHeight;
  const top = typeof options.y === 'number' ? options.y : options.y(blockHeight);

  for (const [index, line] of lines.entries()) {
    const y = top + index * lineHeight;
    ctx.strokeText(line, options.x, y);
    ctx.fillText(line, options.x, y);
  }

  return { png: canvas.toBuffer('image/png'), blockHeight };
}

/** The hook: large, centred, in the upper third. */
export function renderHookLayer(text: string, options: { textColor?: string } = {}): TextLayer {
  return renderLayer({
    text,
    fontSize: HOOK.fontSize,
    lineHeightRatio: HOOK.lineHeightRatio,
    maxWidth: HOOK.maxWidth,
    align: 'center',
    x: WIDTH / 2,
    y: HOOK.top,
    textColor: options.textColor ?? DEFAULT_TEXT_COLOR,
  });
}

/** The sizing block: smaller, in whichever corner the director chose. */
export function renderSizingLayer(
  text: string,
  placement: SizingPlacement,
  options: { textColor?: string } = {}
): TextLayer {
  const known = SIZING_PLACEMENTS.includes(placement) ? placement : 'bottom-left';
  const [vertical, horizontal] = known.split('-');

  const align = horizontal === 'center' ? 'center' : (horizontal as 'left' | 'right');
  const x =
    horizontal === 'left' ? SIZING.margin
      : horizontal === 'right' ? WIDTH - SIZING.margin
      : WIDTH / 2;

  return renderLayer({
    text,
    fontSize: SIZING.fontSize,
    lineHeightRatio: SIZING.lineHeightRatio,
    maxWidth: SIZING.maxWidth,
    align,
    x,
    y: vertical === 'top'
      ? SIZING.margin
      : (blockHeight: number) => HEIGHT - SIZING.margin - blockHeight,
    textColor: options.textColor ?? DEFAULT_TEXT_COLOR,
  });
}
```

Thread `textColor` through `overlayText` (its `input` type and the two layer-render calls):

```typescript
export async function overlayText(input: {
  sourcePath: string;
  outputPath: string;
  hookText: string;
  sizing?: { text: string; placement: SizingPlacement } | null;
  tempDir: string;
  textColor?: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const layers: PreparedLayer[] = [];
  const unique = `${path.basename(input.outputPath, path.extname(input.outputPath))}-${process.pid}`;

  try {
    if (input.hookText.trim()) {
      const png = renderHookLayer(input.hookText, { textColor: input.textColor }).png;
      const file = path.join(input.tempDir, `hook-${unique}.png`);
      layers.push({ file, from: 0, to: HOOK.seconds });
      await writeFile(file, png);
    }

    if (input.sizing?.text.trim()) {
      const png = renderSizingLayer(input.sizing.text, input.sizing.placement, {
        textColor: input.textColor,
      }).png;
      const duration =
        (await probeMedia(input.sourcePath)).containerDuration ?? SIZING.seconds * 3;
      const from = duration / 3;
      const file = path.join(input.tempDir, `sizing-${unique}.png`);
      layers.push({ file, from, to: from + SIZING.seconds });
      await writeFile(file, png);
    }

    // ...rest of the function is unchanged...
  } catch (error) {
    // ...unchanged...
  } finally {
    // ...unchanged...
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/render/text.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing renderPlan test**

`tests/lib/render/renderPlan.test.ts` records pixel data during the mocked upload, before `renderPlan` deletes its temp directory (the same reason it already measures width/height/duration there — see the comment on `uploadedVideoProperties`). Add `@napi-rs/canvas` to its imports, extend what `mockUpload` records, and add the style/color test:

```typescript
// tests/lib/render/renderPlan.test.ts — add to imports
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { styles } from '@/db/schema';

// Replace the `uploadedVideoProperties` declaration:
let uploadedVideoProperties: {
  width: number;
  height: number;
  durationSeconds: number;
  hookPixel: { r: number; g: number; b: number };
}[];

// Replace the mockUpload.mockImplementation in beforeEach with a version that
// also samples the pixel at the hook's on-screen position (upper third,
// centered) from a frame taken at t=1s, before the file is cleaned up:
let uploadFrameCount = 0;
mockUpload.mockImplementation(async (localPath: string) => {
  const media = await probeMedia(localPath);
  const framePath = path.join(fixturesDir, `upload-frame-${uploadFrameCount++}.png`);
  await runFfmpeg(['-ss', '1', '-i', localPath, '-frames:v', '1', framePath]);
  const image = await loadImage(framePath);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(Math.round(image.width / 2), Math.round(image.height * 0.15), 1, 1);
  uploadedVideoProperties.push({
    width: media.video?.width ?? 0,
    height: media.video?.height ?? 0,
    durationSeconds: await probeDuration(localPath),
    hookPixel: { r: data[0], g: data[1], b: data[2] },
  });
  return { success: true };
});
```

Add the test itself:

```typescript
it("renders the hook text in the job's style color", async () => {
  const [style] = await db
    .insert(styles)
    .values({
      name: 'Test Render Color Style',
      description: 'test',
      config: {
        cutMinSeconds: 2,
        cutMaxSeconds: 5,
        hookStyleLibrary: ['x'],
        textColor: '#00ff00',
        variesClipOrder: false,
        usesInspirationOverlay: false,
      },
    })
    .returning();

  const styledJob = await createJob({
    creatorId,
    productName: 'Styled Color Product',
    sizingOverlayEnabled: false,
    lengthSeconds: 15,
    styleId: style.id,
    variationCount: 1,
    clips: [{ storageKey: 'clips/a.mp4', originalFilename: 'a.mp4' }],
  });
  const [styledClip] = await db.select().from(rawClips).where(eq(rawClips.jobId, styledJob.id));

  const [plan] = await db
    .insert(editPlans)
    .values({
      jobId: styledJob.id,
      variationNumber: 1,
      segments: [{ rawClipId: styledClip.id, startSeconds: 0, endSeconds: 4 }],
      hookText: 'Green hook check',
      sizingOverlayText: null,
      sizingOverlayPlacement: null,
    })
    .returning();

  const result = await renderPlan(plan.id);

  expect(result.success).toBe(true);
  const rendered = uploadedVideoProperties[0];
  // Green dominant over red and blue: proves the style's color actually
  // reached the renderer, not merely that rendering succeeded.
  expect(rendered.hookPixel.g).toBeGreaterThan(rendered.hookPixel.r);
  expect(rendered.hookPixel.g).toBeGreaterThan(rendered.hookPixel.b);
}, 120_000);
```

(`mockDownload` already resolves `clips/a.mp4` to the shared red fixture clip regardless of which job requested it, so no change is needed there.)

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- tests/lib/render/renderPlan.test.ts`
Expected: FAIL — `renderPlan` does not look up a style or pass `textColor` yet.

- [ ] **Step 7: Update `lib/render/renderPlan.ts`**

```typescript
// renderPlan.ts — add to imports
import { editPlans, rawClips, jobs, styles } from '@/db/schema';
import { StyleConfigSchema } from '@/lib/styles';

// Inside renderPlan, right after `const plan = ...` is confirmed to exist:
const [job] = await db.select().from(jobs).where(eq(jobs.id, plan.jobId));
if (!job) {
  return { success: false, error: `Job ${plan.jobId} for edit plan ${editPlanId} was not found` };
}

let textColor: string | undefined;
if (job.styleId) {
  const [styleRow] = await db.select().from(styles).where(eq(styles.id, job.styleId));
  if (styleRow) {
    const parsed = StyleConfigSchema.safeParse(styleRow.config);
    if (parsed.success) textColor = parsed.data.textColor;
  }
}

// ...further down, in the overlayText({...}) call, add:
const textResult = await overlayText({
  sourcePath: concatPath,
  outputPath: finalPath,
  hookText: plan.hookText,
  sizing: plan.sizingOverlayText
    ? {
        text: plan.sizingOverlayText,
        placement: (plan.sizingOverlayPlacement ?? 'bottom-left') as OverlayPlacement,
      }
    : null,
  tempDir,
  textColor,
});
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- tests/lib/render/renderPlan.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add lib/render/text.ts lib/render/renderPlan.ts tests/lib/render/text.test.ts tests/lib/render/renderPlan.test.ts
git commit -m "feat: render hook and sizing text in a style's color"
```

---

## Task 9: Renderer — inspiration photo overlay

**Files:**
- Create: `db/repositories/jobInspirationImages.ts`
- Modify: `lib/render/text.ts`
- Modify: `lib/render/renderPlan.ts`
- Test: `tests/db/repositories/jobInspirationImages.test.ts`, `tests/lib/render/text.test.ts`, `tests/lib/render/renderPlan.test.ts` (extend the latter two)

**Interfaces:**
- Consumes: `jobInspirationImages` table (Task 1), `styles.config.usesInspirationOverlay` (Task 2).
- Produces: `getInspirationImageForJob(jobId)`; `overlayText` accepts an optional `inspirationImagePath`, composited as a bordered thumbnail in the upper-left for the first ~4 seconds.

- [ ] **Step 1: Write the failing repository test**

Create `tests/db/repositories/jobInspirationImages.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators, jobs, jobInspirationImages } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { getInspirationImageForJob } from '@/db/repositories/jobInspirationImages';

describe('getInspirationImageForJob', () => {
  const CLERK_ID = 'test_clerk_user_inspo_images';

  it('returns the storage key for a job with an inspiration image', async () => {
    const creator = await createCreatorIfNotExists(CLERK_ID);
    const job = await createJob({
      creatorId: creator.id,
      productName: 'Denim',
      sizingOverlayEnabled: false,
      lengthSeconds: 15,
      pacing: 'fast',
      variationCount: 1,
      clips: [],
      inspirationImage: { storageKey: 'inspiration/repo-test.jpg' },
    });

    const result = await getInspirationImageForJob(job.id);
    expect(result?.storageKey).toBe('inspiration/repo-test.jpg');
  });

  it('returns undefined for a job with no inspiration image', async () => {
    const creator = await createCreatorIfNotExists(CLERK_ID);
    const job = await createJob({
      creatorId: creator.id,
      productName: 'Denim',
      sizingOverlayEnabled: false,
      lengthSeconds: 15,
      pacing: 'fast',
      variationCount: 1,
      clips: [],
    });

    const result = await getInspirationImageForJob(job.id);
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/db/repositories/jobInspirationImages.test.ts`
Expected: FAIL — `@/db/repositories/jobInspirationImages` doesn't exist yet.

- [ ] **Step 3: Write `db/repositories/jobInspirationImages.ts`**

```typescript
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobInspirationImages } from '@/db/schema';

export async function getInspirationImageForJob(jobId: string) {
  return db.query.jobInspirationImages.findFirst({ where: eq(jobInspirationImages.jobId, jobId) });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/db/repositories/jobInspirationImages.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing text-rendering test**

Add this test inside the existing `describe('overlayText', ...)` block in `tests/lib/render/text.test.ts`, reusing that block's own `dir` and 12-second `source` fixture (built once in its `beforeAll`) rather than creating a new video:

```typescript
it('composites an uploaded inspiration photo into the first few seconds only', async () => {
  // A small solid-green JPEG, clearly distinguishable from the black source
  // and from the white hook/sizing text.
  const imgCanvas = createCanvas(200, 300);
  const imgCtx = imgCanvas.getContext('2d');
  imgCtx.fillStyle = '#00ff00';
  imgCtx.fillRect(0, 0, 200, 300);
  const imagePath = path.join(dir, 'inspiration.jpg');
  await writeFile(imagePath, imgCanvas.toBuffer('image/jpeg'));

  const out = path.join(dir, 'inspiration-overlaid.mp4');
  const result = await overlayText({
    sourcePath: source,
    outputPath: out,
    hookText: '',
    tempDir: dir,
    inspirationImagePath: imagePath,
  });

  expect(result.success).toBe(true);

  // t=1s: inside the image's 4s window, upper-left.
  const early = await frameInk(out, 1, dir);
  expect(early.count).toBeGreaterThan(0);
  expect(early.box?.left).toBeLessThan(WIDTH / 2);
  expect(early.box?.top).toBeLessThan(HEIGHT / 2);

  // t=9s: long past the 4s window — a pop-up, not a watermark.
  expect((await frameInk(out, 9, dir)).count).toBeLessThan(200);
}, 180_000);
```

This needs `createCanvas` and `writeFile` imported at the top of the file — `createCanvas`/`loadImage` are already imported (used by `inkOf`); add `writeFile` from `'fs/promises'` alongside the existing `mkdtemp`/`rm`/`readdir` import.

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- tests/lib/render/text.test.ts`
Expected: FAIL — `overlayText` doesn't accept `inspirationImagePath` yet.

- [ ] **Step 7: Update `lib/render/text.ts`**

Add the constant and extend `overlayText`:

```typescript
/** How long the pop-up inspiration photo stays up, matching the hook's window. */
const INSPIRATION_IMAGE = {
  seconds: 4,
  /** Fixed thumbnail box in the upper-left, clear of the frame edge. */
  width: 320,
  height: 480,
  margin: 40,
};

export async function overlayText(input: {
  sourcePath: string;
  outputPath: string;
  hookText: string;
  sizing?: { text: string; placement: SizingPlacement } | null;
  tempDir: string;
  textColor?: string;
  inspirationImagePath?: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const layers: PreparedLayer[] = [];
  const unique = `${path.basename(input.outputPath, path.extname(input.outputPath))}-${process.pid}`;
  const imageLayers: { file: string; from: number; to: number }[] = [];

  try {
    if (input.hookText.trim()) {
      const png = renderHookLayer(input.hookText, { textColor: input.textColor }).png;
      const file = path.join(input.tempDir, `hook-${unique}.png`);
      layers.push({ file, from: 0, to: HOOK.seconds });
      await writeFile(file, png);
    }

    if (input.sizing?.text.trim()) {
      const png = renderSizingLayer(input.sizing.text, input.sizing.placement, {
        textColor: input.textColor,
      }).png;
      const duration =
        (await probeMedia(input.sourcePath)).containerDuration ?? SIZING.seconds * 3;
      const from = duration / 3;
      const file = path.join(input.tempDir, `sizing-${unique}.png`);
      layers.push({ file, from, to: from + SIZING.seconds });
      await writeFile(file, png);
    }

    if (input.inspirationImagePath) {
      imageLayers.push({ file: input.inspirationImagePath, from: 0, to: INSPIRATION_IMAGE.seconds });
    }

    if (layers.length === 0 && imageLayers.length === 0) {
      const copied = await runFfmpeg([
        '-i', input.sourcePath,
        '-c', 'copy',
        '-movflags', '+faststart',
        input.outputPath,
      ]);
      if (!copied.success) await discardOutput(input.outputPath);
      return copied;
    }

    // Text layers are full-frame PNGs, overlaid at 0,0. The image layer is an
    // arbitrary-sized photo, so it is scaled to a fixed thumbnail box first and
    // overlaid in the upper-left corner — a different position and a different
    // input type, but the same "extra input, same enable-window overlay" chain
    // the text layers already use.
    const allInputs = [...layers.map((l) => l.file), ...imageLayers.map((l) => l.file)];
    const inputs = allInputs.flatMap((file) => ['-i', file]);

    const filters: string[] = [];
    let current = '[0:v]';
    let inputIndex = 1;

    for (const layer of layers) {
      const label = `[t${inputIndex}]`;
      const window = `between(t,${formatSeconds(layer.from)},${formatSeconds(layer.to)})`;
      filters.push(`${current}[${inputIndex}:v]overlay=0:0:enable='${window}'${label}`);
      current = label;
      inputIndex += 1;
    }

    for (const layer of imageLayers) {
      const scaled = `[img${inputIndex}]`;
      filters.push(
        `[${inputIndex}:v]scale=${INSPIRATION_IMAGE.width}:${INSPIRATION_IMAGE.height}${scaled}`
      );
      const label = `[t${inputIndex}]`;
      const window = `between(t,${formatSeconds(layer.from)},${formatSeconds(layer.to)})`;
      filters.push(
        `${current}${scaled}overlay=${INSPIRATION_IMAGE.margin}:${INSPIRATION_IMAGE.margin}:enable='${window}'${label}`
      );
      current = label;
      inputIndex += 1;
    }

    // The last filter's output must be relabelled `[v]` for `-map` below.
    const chain = filters.join(';').replace(new RegExp(`\\[t${inputIndex - 1}\\]$`), '[v]');

    const result = await runFfmpeg([
      '-i', input.sourcePath,
      ...inputs,
      '-filter_complex', chain,
      '-map', '[v]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      input.outputPath,
    ]);

    if (!result.success) await discardOutput(input.outputPath);
    return result;
  } catch (error) {
    await discardOutput(input.outputPath);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    for (const layer of layers) {
      await rm(layer.file, { force: true }).catch(() => {});
    }
    // Note: imageLayers' files belong to the caller (a downloaded temp clip in
    // renderPlan's case) and are not removed here.
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- tests/lib/render/text.test.ts`
Expected: PASS

- [ ] **Step 9: Write the failing renderPlan test**

`mockDownload` needs to resolve one more storage key (the inspiration image) to a local file. Extend its implementation and add the test:

```typescript
// tests/lib/render/renderPlan.test.ts — extend mockDownload's mapping (in beforeEach)
mockDownload.mockImplementation(async (storageKey: string) => {
  const path_ =
    storageKey === 'clips/a.mp4' ? clipAPath
      : storageKey === 'clips/b.mp4' ? clipBPath
      : inspirationImagePath;
  return { path: path_, contentType: 'video/mp4', cleanUp: vi.fn(async () => {}) };
});
```

Build the inspiration image fixture once in `beforeAll`, alongside `clipAPath`/`clipBPath`:

```typescript
// tests/lib/render/renderPlan.test.ts — add to the top-level `let` declarations
let inspirationImagePath: string;

// tests/lib/render/renderPlan.test.ts — inside beforeAll, after clipA/clipB are built
inspirationImagePath = path.join(fixturesDir, 'inspiration.jpg');
const imgCanvas = createCanvas(200, 300);
const imgCtx = imgCanvas.getContext('2d');
imgCtx.fillStyle = '#00ff00';
imgCtx.fillRect(0, 0, 200, 300);
await require('fs/promises').writeFile(inspirationImagePath, imgCanvas.toBuffer('image/jpeg'));
```

```typescript
it('composites the inspiration photo when the job has one', async () => {
  const [style] = await db
    .insert(styles)
    .values({
      name: 'Test Render Inspo Style',
      description: 'test',
      config: {
        cutMinSeconds: 2,
        cutMaxSeconds: 5,
        hookStyleLibrary: ['x'],
        variesClipOrder: false,
        usesInspirationOverlay: true,
      },
    })
    .returning();

  const inspoJob = await createJob({
    creatorId,
    productName: 'Inspiration Overlay Product',
    sizingOverlayEnabled: false,
    lengthSeconds: 15,
    styleId: style.id,
    variationCount: 1,
    clips: [{ storageKey: 'clips/a.mp4', originalFilename: 'a.mp4' }],
    inspirationImage: { storageKey: 'inspiration/test.jpg' },
  });
  const [inspoClip] = await db.select().from(rawClips).where(eq(rawClips.jobId, inspoJob.id));

  const [plan] = await db
    .insert(editPlans)
    .values({
      jobId: inspoJob.id,
      variationNumber: 1,
      segments: [{ rawClipId: inspoClip.id, startSeconds: 0, endSeconds: 4 }],
      hookText: '',
      sizingOverlayText: null,
      sizingOverlayPlacement: null,
    })
    .returning();

  const result = await renderPlan(plan.id);

  expect(result.success).toBe(true);
  // The inspiration image is downloaded alongside the source clip: two calls,
  // one per distinct storage key.
  expect(mockDownload).toHaveBeenCalledWith('inspiration/test.jpg');
}, 120_000);
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npm test -- tests/lib/render/renderPlan.test.ts`
Expected: FAIL — `renderPlan` never looks up an inspiration image yet.

- [ ] **Step 11: Update `lib/render/renderPlan.ts`**

Task 8 already added a `styleRow`/`parsed` lookup for `textColor`; extend that same block rather than querying `styles` twice:

```typescript
// renderPlan.ts — add to imports
import { getInspirationImageForJob } from '@/db/repositories/jobInspirationImages';

// Replace Task 8's style-lookup block with this extended version:
let textColor: string | undefined;
let inspirationImageClip: LocalClip | undefined;
if (job.styleId) {
  const [styleRow] = await db.select().from(styles).where(eq(styles.id, job.styleId));
  if (styleRow) {
    const parsed = StyleConfigSchema.safeParse(styleRow.config);
    if (parsed.success) {
      textColor = parsed.data.textColor;
      if (parsed.data.usesInspirationOverlay) {
        const inspirationImage = await getInspirationImageForJob(plan.jobId);
        if (inspirationImage) {
          inspirationImageClip = await downloadClipToTempFile(inspirationImage.storageKey);
          downloadedClips.push(inspirationImageClip); // reuses the existing cleanup loop
        }
      }
    }
  }
}

// In the overlayText({...}) call:
const textResult = await overlayText({
  sourcePath: concatPath,
  outputPath: finalPath,
  hookText: plan.hookText,
  sizing: plan.sizingOverlayText
    ? {
        text: plan.sizingOverlayText,
        placement: (plan.sizingOverlayPlacement ?? 'bottom-left') as OverlayPlacement,
      }
    : null,
  tempDir,
  textColor,
  inspirationImagePath: inspirationImageClip?.path,
});
```

(`downloadClipToTempFile` is already generic over any R2 object key — nothing clip-specific about its implementation — so no new storage helper is needed; it is reused as-is for the inspiration photo.)

- [ ] **Step 12: Run the test to verify it passes**

Run: `npm test -- tests/lib/render/renderPlan.test.ts`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add db/repositories/jobInspirationImages.ts lib/render/text.ts lib/render/renderPlan.ts tests/db/repositories/jobInspirationImages.test.ts tests/lib/render/text.test.ts tests/lib/render/renderPlan.test.ts
git commit -m "feat: composite an uploaded inspiration photo for styles that use one"
```

---

## Task 10: End-to-end — run all three paths against real footage

**Files:** none (manual verification, matching the convention of every prior stage's final task).

**Interfaces:**
- Consumes: everything built in Tasks 1-9.

- [ ] **Step 1: Seed the two styles against the real dev database**

Run: `npm run seed:styles`

- [ ] **Step 2: Create three jobs through the actual UI**

Using the `run` skill and the creator's own reference clips already on disk (`example-videos/style 1/*.mp4`, `example-videos/style 2/*.mov`) as raw clip uploads:
1. A Custom-mode job (today's flow, unchanged) — confirms no regression.
2. A "Single-Shot Try-On" Style-mode job.
3. A "Dupe Flip" Style-mode job with an inspiration photo uploaded.

- [ ] **Step 3: Run the pipeline for all three**

Run: `npm run worker` (or trigger tagging/planning/rendering the same way Stage 2/3's end-to-end tasks did) until all three jobs reach `done`.

- [ ] **Step 4: Download and watch every rendered variation**

Save them under `local-videos/Test N/` (the next sequential number after the existing `local-videos/Test 1/`), per the established convention. For each job, confirm:
- The Custom job looks exactly as it did before this feature shipped.
- The "Single-Shot Try-On" job has no forced cuts, the hook/sizing overlay render in white in the correct corners, and (if that style's variation count > 1) hook text still varies across variations.
- The "Dupe Flip" job actually alternates clip order across its variations (some open on b-roll, some on try-on), the sizing overlay is pinned bottom-left, and the inspiration photo appears in the first few seconds of at least one variation and is gone by the end.

- [ ] **Step 5: Report findings to the user**

Send the actual rendered files (per this codebase's established practice of sending real output for subjective judgment, not just asserting structural correctness) and note anything that needs a second pass — matching the explicit expectation set by the Stage 3 plan's own "watch the real videos" task.
