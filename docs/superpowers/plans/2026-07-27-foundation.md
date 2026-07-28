# Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up accounts/auth, a database, file storage, a creator profile, and a working job-creation flow (upload clips + fill in job settings + save) — no AI or video rendering yet. This is Stage 1 of 3 for the UGC AI Editor (see `docs/superpowers/specs/2026-07-27-ugc-ai-editor-design.md`).

**Architecture:** Next.js (App Router, TypeScript) web app. Clerk for auth, Supabase Postgres (via Drizzle ORM) for data, Cloudflare R2 (S3-compatible) for raw clip storage. Business logic (validation, data access) is unit-tested with Vitest; UI pages are verified manually in the browser at the end of their task, since they're thin wrappers around already-tested logic.

**Tech Stack:** Next.js 14 (App Router) + TypeScript, Clerk, Drizzle ORM + Supabase Postgres, Cloudflare R2 via `@aws-sdk/client-s3`, Vitest, npm.

## Global Constraints

- Package manager: npm. Node.js 20+.
- All server-side env vars are read through `getRequiredEnv()` (Task 1) — never `process.env.X` directly — so a missing var fails loudly at startup, not silently mid-request.
- Height and weight are stored as free-text (e.g. `"5'6\""`, `"135 lbs"`) — no units enforced or converted, per the spec.
- `product_name` is a plain text column on `jobs`. There is no separate product-profile entity (per spec decision: fully freeform product input, no reusable profiles).
- Video length is restricted to the presets `15 | 30 | 45 | 60` (seconds). Pacing is restricted to `'slow' | 'medium' | 'fast'`. Both are enforced in `lib/validation/job.ts`, not just at the database level.
- `size_worn` is only required when `sizing_overlay_enabled` is true — enforced in `validateJobInput`.
- No credit/billing logic exists yet — that's Stage 3. Jobs have no cost associated with them in this stage.
- Tests that touch the database run against your real (dev) Supabase project — acceptable at this stage since it's just you and one tester; revisit with a dedicated test database before this becomes a team project.
- UI pages are verified manually in-browser (steps are given per task) rather than via automated component tests — automated tests cover validation, data access, storage, and API route logic, which is where the real risk is.

---

## Task 0: Account & environment setup

This task has no code — it's you creating three free accounts and handing me the keys so the rest of the plan can be built and tested. I'll tell you exactly what to click.

- [ ] **Step 1: Create a Supabase project (free tier)**
  1. Go to supabase.com and sign up / log in.
  2. Click "New project." Name it `ugc-ai-editor`, choose any region close to you, set a database password (save it somewhere).
  3. Once it's created, click **Connect** (top of the project dashboard) and copy the **Transaction pooler** connection string — not the "Direct connection" one (its host is IPv6-only and unreachable from most home networks). It looks like `postgresql://postgres.<project-ref>:[password]@aws-0-<region>.pooler.supabase.com:6543/postgres`.
  4. Send me that string — it becomes `DATABASE_URL`.

- [ ] **Step 2: Create a Clerk application (free tier)**
  1. Go to clerk.com and sign up / log in.
  2. Create a new application, name it `UGC AI Editor`. Enable "Email" as a sign-in method (that's enough for now).
  3. In the dashboard, go to **API Keys** and copy the **Publishable key** and **Secret key**.
  4. Go to **Webhooks → Add Endpoint**. For now, put a placeholder URL like `https://example.com/api/webhooks/clerk` (I'll give you the real one once we deploy) and subscribe to the `user.created` event. Copy the **Signing Secret** it gives you.
  5. Send me the publishable key, secret key, and signing secret — they become `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `CLERK_WEBHOOK_SECRET`.

- [ ] **Step 3: Create a Cloudflare R2 bucket (free tier)**
  1. Go to dash.cloudflare.com, sign up / log in, and open the **R2** section.
  2. Create a bucket named `ugc-ai-editor-clips`.
  3. Go to **R2 → Manage API Tokens → Create API Token**, give it read/write access to that bucket. Copy the **Access Key ID** and **Secret Access Key** it shows you (only shown once).
  4. On the R2 overview page, note your **Account ID** (shown in the right sidebar).
  5. **Required for uploads to work:** open the bucket → **Settings → CORS Policy** → add a policy allowing `AllowedOrigins: ["http://localhost:3000"]` (add your production URL here too once deployed), `AllowedMethods: ["PUT"]`, `AllowedHeaders: ["Content-Type"]`. Without this, every upload from the browser fails with an opaque CORS error, since the app uploads directly from the browser to R2.
  6. Send me the account ID, access key ID, and secret access key — they become `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. The bucket name (`ugc-ai-editor-clips`) becomes `R2_BUCKET_NAME`.

- [ ] **Step 4: I assemble `.env.local`**
  Once you send me the values from Steps 1-3, I'll create a `.env.local` file in the project with all of them, plus placeholders for the Clerk publishable/secret keys formatted correctly. This file is git-ignored — it never gets committed.

---

## Task 1: Project scaffold + environment validation helper

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `app/layout.tsx`, `app/page.tsx`, `.gitignore`
- Create: `lib/env.ts`
- Test: `tests/lib/env.test.ts`

**Interfaces:**
- Produces: `getRequiredEnv(name: string): string` — throws `Error("Missing required environment variable: <name>")` if unset. Used by every later task that reads an env var.

- [ ] **Step 1: Scaffold the Next.js app**

Run: `npx create-next-app@latest . --typescript --eslint --app --src-dir=false --import-alias "@/*" --no-tailwind --use-npm`

- [ ] **Step 2: Install Vitest**

Run: `npm install -D vitest`

- [ ] **Step 3: Add `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
```

- [ ] **Step 4: Add a test setup file with dummy env vars**

```typescript
// tests/setup.ts
process.env.R2_ACCOUNT_ID ||= 'test-account-id';
process.env.R2_ACCESS_KEY_ID ||= 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY ||= 'test-secret-key';
process.env.R2_BUCKET_NAME ||= 'test-bucket';
```

- [ ] **Step 5: Add the `test` script to `package.json`**

```json
"scripts": {
  "test": "vitest run"
}
```

- [ ] **Step 6: Write the failing test for `getRequiredEnv`**

```typescript
// tests/lib/env.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { getRequiredEnv } from '@/lib/env';

describe('getRequiredEnv', () => {
  const KEY = 'TEST_ONLY_ENV_VAR';

  afterEach(() => {
    delete process.env[KEY];
  });

  it('returns the value when the env var is set', () => {
    process.env[KEY] = 'hello';
    expect(getRequiredEnv(KEY)).toBe('hello');
  });

  it('throws a clear error when the env var is missing', () => {
    delete process.env[KEY];
    expect(() => getRequiredEnv(KEY)).toThrow(
      'Missing required environment variable: TEST_ONLY_ENV_VAR'
    );
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -- tests/lib/env.test.ts`
Expected: FAIL — `lib/env.ts` does not exist yet.

- [ ] **Step 8: Implement `getRequiredEnv`**

```typescript
// lib/env.ts
export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -- tests/lib/env.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json next.config.ts vitest.config.ts app tests lib .gitignore
git commit -m "chore: scaffold Next.js app with Vitest and env validation helper"
```

---

## Task 2: Database schema & migration

**Files:**
- Create: `db/schema.ts`, `db/client.ts`, `drizzle.config.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Consumes: `getRequiredEnv` (Task 1)
- Produces: `db` (Drizzle client, from `db/client.ts`), and the Drizzle table objects `creators`, `jobs`, `rawClips` (from `db/schema.ts`) — used by every repository in later tasks.

- [ ] **Step 1: Install Drizzle and the Postgres driver**

Run: `npm install drizzle-orm postgres` and `npm install -D drizzle-kit`

- [ ] **Step 2: Write the schema**

```typescript
// db/schema.ts
import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const pacingEnum = pgEnum('pacing', ['slow', 'medium', 'fast']);
export const jobStatusEnum = pgEnum('job_status', ['pending']);

export const creators = pgTable('creators', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  height: text('height'),
  weight: text('weight'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id').notNull().references(() => creators.id),
  productName: text('product_name').notNull(),
  sizeWorn: text('size_worn'),
  sizingOverlayEnabled: boolean('sizing_overlay_enabled').notNull().default(false),
  lengthSeconds: integer('length_seconds').notNull(),
  pacing: pacingEnum('pacing').notNull(),
  variationCount: integer('variation_count').notNull(),
  status: jobStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rawClips = pgTable('raw_clips', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  storageKey: text('storage_key').notNull(),
  originalFilename: text('original_filename').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 3: Write the Drizzle client**

```typescript
// db/client.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getRequiredEnv } from '@/lib/env';
import * as schema from './schema';

const queryClient = postgres(getRequiredEnv('DATABASE_URL'));
export const db = drizzle(queryClient, { schema });
```

- [ ] **Step 4: Write `drizzle.config.ts`**

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 5: Write the failing schema test**

```typescript
// tests/db/schema.test.ts
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

describe('database schema', () => {
  it('creates the creators, jobs, and raw_clips tables with expected columns', async () => {
    const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('creators', 'jobs', 'raw_clips')
    `);

    const columns = rows.map((r) => `${r.table_name}.${r.column_name}`);

    expect(columns).toEqual(
      expect.arrayContaining([
        'creators.clerk_user_id',
        'creators.height',
        'creators.weight',
        'jobs.product_name',
        'jobs.size_worn',
        'jobs.sizing_overlay_enabled',
        'jobs.length_seconds',
        'jobs.pacing',
        'jobs.variation_count',
        'jobs.status',
        'raw_clips.storage_key',
        'raw_clips.original_filename',
        'raw_clips.job_id',
      ])
    );
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- tests/db/schema.test.ts`
Expected: FAIL — tables don't exist in the database yet.

- [ ] **Step 7: Generate and apply the migration**

Run: `npx drizzle-kit generate` then `npx drizzle-kit migrate`

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- tests/db/schema.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add db drizzle.config.ts tests/db package.json package-lock.json
git commit -m "feat: add database schema for creators, jobs, and raw clips"
```

---

## Task 3: Clerk auth + creator auto-provisioning

> **Deviation from original plan (2026-07-27):** at the human's request, the generic Clerk plumbing (installing `@clerk/nextjs`, wrapping the app in `ClerkProvider`, route protection, sign-in/sign-up pages) was done by running Clerk's own official CLI (`clerk init`) instead of hand-written per the original Steps 1, 6, and 7 below. That CLI created **`proxy.ts`** (not `middleware.ts` — this is current Next.js/Clerk convention) with a matcher that covers the whole app, and routes are **public by default** under this model (no `auth.protect()` calls exist yet). This is fine for V1: every data-touching API route in this plan (`/api/profile`, `/api/jobs`, `/api/uploads/presign`) already manually checks `const { userId } = await auth(); if (!userId) return 401` before doing anything, so there is no unauthenticated access to data even though the page routes themselves aren't gated at the proxy level. Steps 6 and 7 below are struck out as already done. The remaining steps — the webhook and the creator repository — are Clerk-CLI-agnostic application logic and still need to be built exactly as written.

**Files:**
- ~~Modify: `app/layout.tsx`~~ (done via `clerk init`)
- Create: `db/repositories/creators.ts`, `app/api/webhooks/clerk/route.ts`
- Test: `tests/db/repositories/creators.test.ts`

**Interfaces:**
- Consumes: `db`, `creators` (Task 2), `getRequiredEnv` (Task 1)
- Produces: `createCreatorIfNotExists(clerkUserId: string): Promise<Creator>`, `getCreatorByClerkId(clerkUserId: string): Promise<Creator | undefined>` — used by Task 4 (profile) and Task 6 (job creation).

- [ ] **Step 1: Install svix (webhook verification) — `@clerk/nextjs` is already installed**

Run: `npm install svix`

- [ ] **Step 2: Write the failing repository test**

```typescript
// tests/db/repositories/creators.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators } from '@/db/schema';
import { createCreatorIfNotExists, getCreatorByClerkId } from '@/db/repositories/creators';

describe('creator repository', () => {
  const CLERK_ID = 'test_clerk_user_1';

  beforeEach(async () => {
    await db.delete(creators).where(eq(creators.clerkUserId, CLERK_ID));
  });

  it('creates a new creator row for a first-time clerk user', async () => {
    const creator = await createCreatorIfNotExists(CLERK_ID);
    expect(creator.clerkUserId).toBe(CLERK_ID);

    const fetched = await getCreatorByClerkId(CLERK_ID);
    expect(fetched?.id).toBe(creator.id);
  });

  it('does not create a duplicate row when called twice for the same user', async () => {
    const first = await createCreatorIfNotExists(CLERK_ID);
    const second = await createCreatorIfNotExists(CLERK_ID);
    expect(second.id).toBe(first.id);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/db/repositories/creators.test.ts`
Expected: FAIL — `db/repositories/creators.ts` does not exist.

- [ ] **Step 4: Implement the repository**

```typescript
// db/repositories/creators.ts
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators } from '@/db/schema';

export async function createCreatorIfNotExists(clerkUserId: string) {
  const existing = await db.query.creators.findFirst({
    where: eq(creators.clerkUserId, clerkUserId),
  });
  if (existing) return existing;

  const [created] = await db.insert(creators).values({ clerkUserId }).returning();
  return created;
}

export async function getCreatorByClerkId(clerkUserId: string) {
  return db.query.creators.findFirst({
    where: eq(creators.clerkUserId, clerkUserId),
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/db/repositories/creators.test.ts`
Expected: PASS (2 tests)

- [x] ~~Step 6: Wrap the app in `ClerkProvider`~~ — already done, see `app/layout.tsx` (commit `7c89c45`)

- [x] ~~Step 7: Add middleware to protect `/profile` and `/jobs`~~ — superseded by Clerk CLI's `proxy.ts` (commit `7c89c45`); see the Deviation note above for why per-route API auth checks are sufficient without page-level gating in V1.

- [ ] **Step 8: Add the Clerk webhook route**

```typescript
// app/api/webhooks/clerk/route.ts
import { headers } from 'next/headers';
import { Webhook } from 'svix';
import { getRequiredEnv } from '@/lib/env';
import { createCreatorIfNotExists } from '@/db/repositories/creators';

export async function POST(req: Request) {
  const payload = await req.text();
  const headerPayload = await headers();
  const svixHeaders = {
    'svix-id': headerPayload.get('svix-id') ?? '',
    'svix-timestamp': headerPayload.get('svix-timestamp') ?? '',
    'svix-signature': headerPayload.get('svix-signature') ?? '',
  };

  const wh = new Webhook(getRequiredEnv('CLERK_WEBHOOK_SECRET'));
  let event: { type: string; data: { id: string } };
  try {
    event = wh.verify(payload, svixHeaders) as typeof event;
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }

  if (event.type === 'user.created') {
    await createCreatorIfNotExists(event.data.id);
  }

  return new Response('ok', { status: 200 });
}
```

- [ ] **Step 9: Add `.env.local` keys**

Add `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `CLERK_WEBHOOK_SECRET` from Task 0 to `.env.local`.

- [ ] **Step 10: Manual verification**

1. Run `npm run dev`, open `http://localhost:3000`.
2. Sign up with a test email through Clerk's sign-up UI (you'll need a sign-in page — for this manual check, Clerk's hosted account portal works: visit `http://localhost:3000/sign-up` after adding a basic `<SignUp />` page, or just check the Clerk dashboard's "Users" tab shows your new user).
3. In Supabase's table editor, open the `creators` table and confirm a row appeared with your `clerk_user_id`.

- [ ] **Step 11: Commit**

```bash
git add app/api/webhooks db/repositories package.json package-lock.json tests
git commit -m "feat: auto-provision creator record via Clerk webhook on sign-up"
```

---

## Task 4: Creator profile (height/weight) — API + page

**Files:**
- Modify: `db/repositories/creators.ts`
- Create: `app/api/profile/route.ts`, `app/profile/page.tsx`
- Test: `tests/db/repositories/creators.test.ts` (add cases)

**Interfaces:**
- Consumes: `createCreatorIfNotExists`, `getCreatorByClerkId` (Task 3)
- Produces: `updateCreatorProfile(clerkUserId: string, data: { height?: string; weight?: string }): Promise<Creator>` — not used elsewhere in Stage 1, but the shape (`Creator` having `height`/`weight`) is relied on by Stage 3's sizing-overlay rendering.

- [ ] **Step 1: Write the failing test for updating a profile**

```typescript
// tests/db/repositories/creators.test.ts — add inside the existing describe block
it('updates height and weight for an existing creator', async () => {
  await createCreatorIfNotExists(CLERK_ID);
  const updated = await updateCreatorProfile(CLERK_ID, { height: "5'6\"", weight: '135 lbs' });
  expect(updated.height).toBe("5'6\"");
  expect(updated.weight).toBe('135 lbs');
});
```

Update the import line to include `updateCreatorProfile`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/db/repositories/creators.test.ts`
Expected: FAIL — `updateCreatorProfile` is not exported.

- [ ] **Step 3: Implement `updateCreatorProfile`**

```typescript
// db/repositories/creators.ts — add
export async function updateCreatorProfile(
  clerkUserId: string,
  data: { height?: string; weight?: string }
) {
  const [updated] = await db
    .update(creators)
    .set(data)
    .where(eq(creators.clerkUserId, clerkUserId))
    .returning();
  return updated;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/db/repositories/creators.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Add the profile API route**

```typescript
// app/api/profile/route.ts
import { auth } from '@clerk/nextjs/server';
import { getCreatorByClerkId, updateCreatorProfile } from '@/db/repositories/creators';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const creator = await getCreatorByClerkId(userId);
  return Response.json(creator);
}

export async function PATCH(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const body = await req.json();
  const updated = await updateCreatorProfile(userId, {
    height: body.height,
    weight: body.weight,
  });
  return Response.json(updated);
}
```

- [ ] **Step 6: Add the profile page**

```tsx
// app/profile/page.tsx
'use client';

import { useEffect, useState } from 'react';

export default function ProfilePage() {
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/profile')
      .then((res) => res.json())
      .then((data) => {
        setHeight(data?.height ?? '');
        setWeight(data?.weight ?? '');
      });
  }, []);

  async function handleSave() {
    setSaved(false);
    await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ height, weight }),
    });
    setSaved(true);
  }

  return (
    <main>
      <h1>Your Profile</h1>
      <label>
        Height
        <input value={height} onChange={(e) => setHeight(e.target.value)} placeholder={'e.g. 5\'6"'} />
      </label>
      <label>
        Weight
        <input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 135 lbs" />
      </label>
      <button onClick={handleSave}>Save</button>
      {saved && <p>Saved.</p>}
    </main>
  );
}
```

- [ ] **Step 7: Manual verification**

1. `npm run dev`, sign in, go to `http://localhost:3000/profile`.
2. Enter a height and weight, click Save, refresh the page.
3. Confirm the values you entered are still there after refresh (proves it round-trips through the database).

- [ ] **Step 8: Commit**

```bash
git add app/api/profile app/profile db/repositories tests
git commit -m "feat: add creator profile page for height and weight"
```

---

## Task 5: Cloudflare R2 presigned uploads

**Files:**
- Create: `lib/storage.ts`, `app/api/uploads/presign/route.ts`
- Test: `tests/lib/storage.test.ts`

**Interfaces:**
- Consumes: `getRequiredEnv` (Task 1)
- Produces: `createUploadUrl(originalFilename: string, contentType: string): Promise<{ url: string; storageKey: string }>` — used by the job-creation UI in Task 6.

- [ ] **Step 1: Install the AWS S3 SDK (R2 is S3-compatible)**

Run: `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`

- [ ] **Step 2: Write the failing test**

```typescript
// tests/lib/storage.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://example.com/signed-url'),
}));

import { createUploadUrl } from '@/lib/storage';

describe('createUploadUrl', () => {
  it('returns a signed URL and a storage key scoped under clips/', async () => {
    const result = await createUploadUrl('my-clip.mp4', 'video/mp4');
    expect(result.url).toBe('https://example.com/signed-url');
    expect(result.storageKey).toMatch(/^clips\/.+-my-clip\.mp4$/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/lib/storage.test.ts`
Expected: FAIL — `lib/storage.ts` does not exist.

- [ ] **Step 4: Implement `createUploadUrl`**

```typescript
// lib/storage.ts
import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getRequiredEnv } from '@/lib/env';

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${getRequiredEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: getRequiredEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: getRequiredEnv('R2_SECRET_ACCESS_KEY'),
  },
});

export async function createUploadUrl(originalFilename: string, contentType: string) {
  const storageKey = `clips/${randomUUID()}-${originalFilename}`;
  const command = new PutObjectCommand({
    Bucket: getRequiredEnv('R2_BUCKET_NAME'),
    Key: storageKey,
    ContentType: contentType,
  });
  const url = await getSignedUrl(client, command, { expiresIn: 300 });
  return { url, storageKey };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/lib/storage.test.ts`
Expected: PASS

- [ ] **Step 6: Add the presign API route**

```typescript
// app/api/uploads/presign/route.ts
import { auth } from '@clerk/nextjs/server';
import { createUploadUrl } from '@/lib/storage';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const { filename, contentType } = await req.json();
  const result = await createUploadUrl(filename, contentType);
  return Response.json(result);
}
```

- [ ] **Step 7: Add remaining `.env.local` keys**

Add `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` from Task 0 to `.env.local`.

- [ ] **Step 8: Commit**

```bash
git add lib/storage.ts app/api/uploads tests/lib/storage.test.ts package.json package-lock.json
git commit -m "feat: add presigned upload endpoint for R2 clip storage"
```

---

## Task 6: Job creation — validation, API, and upload UI

**Files:**
- Create: `lib/validation/job.ts`, `db/repositories/jobs.ts`, `app/api/jobs/route.ts`, `app/jobs/new/page.tsx`
- Test: `tests/lib/validation/job.test.ts`

**Interfaces:**
- Consumes: `getCreatorByClerkId` (Task 3), `db`, `jobs`, `rawClips` (Task 2), `createUploadUrl` (Task 5)
- Produces: `validateJobInput(input): JobValidationError[]`, `createJob(input: CreateJobInput): Promise<Job>` — used by Task 7 (job list) for the `Job` shape.

- [ ] **Step 1: Write the failing validation tests**

```typescript
// tests/lib/validation/job.test.ts
import { describe, it, expect } from 'vitest';
import { validateJobInput } from '@/lib/validation/job';

const validInput = {
  productName: 'Blue Ribbed Tank Top',
  lengthSeconds: 30,
  pacing: 'medium',
  variationCount: 5,
  sizingOverlayEnabled: false,
  sizeWorn: undefined as string | undefined,
  clipCount: 4,
};

describe('validateJobInput', () => {
  it('returns no errors for valid input', () => {
    expect(validateJobInput(validInput)).toEqual([]);
  });

  it('requires a product name', () => {
    const errors = validateJobInput({ ...validInput, productName: '  ' });
    expect(errors).toContainEqual({ field: 'productName', message: 'Product name is required.' });
  });

  it('rejects a length outside the allowed presets', () => {
    const errors = validateJobInput({ ...validInput, lengthSeconds: 25 });
    expect(errors).toContainEqual({
      field: 'lengthSeconds',
      message: 'Length must be 15, 30, 45, or 60 seconds.',
    });
  });

  it('requires sizeWorn when the sizing overlay is enabled', () => {
    const errors = validateJobInput({ ...validInput, sizingOverlayEnabled: true, sizeWorn: '' });
    expect(errors).toContainEqual({
      field: 'sizeWorn',
      message: 'Size worn is required when sizing info is enabled.',
    });
  });

  it('does not require sizeWorn when the sizing overlay is disabled', () => {
    const errors = validateJobInput({ ...validInput, sizingOverlayEnabled: false, sizeWorn: undefined });
    expect(errors).toEqual([]);
  });

  it('requires at least one clip', () => {
    const errors = validateJobInput({ ...validInput, clipCount: 0 });
    expect(errors).toContainEqual({ field: 'clips', message: 'At least one raw clip is required.' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/lib/validation/job.test.ts`
Expected: FAIL — `lib/validation/job.ts` does not exist.

- [ ] **Step 3: Implement `validateJobInput`**

```typescript
// lib/validation/job.ts
export const ALLOWED_LENGTHS = [15, 30, 45, 60] as const;
export const ALLOWED_PACINGS = ['slow', 'medium', 'fast'] as const;
export const MAX_VARIATION_COUNT = 20;

export type JobValidationError = { field: string; message: string };

export function validateJobInput(input: {
  productName: string;
  lengthSeconds: number;
  pacing: string;
  variationCount: number;
  sizingOverlayEnabled: boolean;
  sizeWorn?: string;
  clipCount: number;
}): JobValidationError[] {
  const errors: JobValidationError[] = [];

  if (!input.productName.trim()) {
    errors.push({ field: 'productName', message: 'Product name is required.' });
  }
  if (!ALLOWED_LENGTHS.includes(input.lengthSeconds as (typeof ALLOWED_LENGTHS)[number])) {
    errors.push({ field: 'lengthSeconds', message: 'Length must be 15, 30, 45, or 60 seconds.' });
  }
  if (!ALLOWED_PACINGS.includes(input.pacing as (typeof ALLOWED_PACINGS)[number])) {
    errors.push({ field: 'pacing', message: 'Pacing must be slow, medium, or fast.' });
  }
  if (input.variationCount < 1 || input.variationCount > MAX_VARIATION_COUNT) {
    errors.push({
      field: 'variationCount',
      message: `Variation count must be between 1 and ${MAX_VARIATION_COUNT}.`,
    });
  }
  if (input.sizingOverlayEnabled && !input.sizeWorn?.trim()) {
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
Expected: PASS (6 tests)

- [ ] **Step 5: Implement the jobs repository**

```typescript
// db/repositories/jobs.ts
import { db } from '@/db/client';
import { jobs, rawClips } from '@/db/schema';

export type CreateJobInput = {
  creatorId: string;
  productName: string;
  sizeWorn?: string;
  sizingOverlayEnabled: boolean;
  lengthSeconds: 15 | 30 | 45 | 60;
  pacing: 'slow' | 'medium' | 'fast';
  variationCount: number;
  clips: { storageKey: string; originalFilename: string }[];
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

    return job;
  });
}
```

(No standalone test for `createJob` here — it's exercised end-to-end by the manual verification step below and by Task 7's `listJobsForCreator` test, which reads back what it wrote.)

- [ ] **Step 6: Add the jobs API route**

```typescript
// app/api/jobs/route.ts
import { auth } from '@clerk/nextjs/server';
import { getCreatorByClerkId } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { validateJobInput } from '@/lib/validation/job';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const creator = await getCreatorByClerkId(userId);
  if (!creator) return new Response('Creator profile not found', { status: 404 });

  const body = await req.json();
  const errors = validateJobInput({
    productName: body.productName ?? '',
    lengthSeconds: body.lengthSeconds,
    pacing: body.pacing,
    variationCount: body.variationCount,
    sizingOverlayEnabled: Boolean(body.sizingOverlayEnabled),
    sizeWorn: body.sizeWorn,
    clipCount: Array.isArray(body.clips) ? body.clips.length : 0,
  });

  if (errors.length > 0) {
    return Response.json({ errors }, { status: 400 });
  }

  const job = await createJob({
    creatorId: creator.id,
    productName: body.productName,
    sizeWorn: body.sizeWorn,
    sizingOverlayEnabled: Boolean(body.sizingOverlayEnabled),
    lengthSeconds: body.lengthSeconds,
    pacing: body.pacing,
    variationCount: body.variationCount,
    clips: body.clips,
  });

  return Response.json(job, { status: 201 });
}
```

- [ ] **Step 7: Add the job creation page**

```tsx
// app/jobs/new/page.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function NewJobPage() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [productName, setProductName] = useState('');
  const [sizingOn, setSizingOn] = useState(false);
  const [sizeWorn, setSizeWorn] = useState('');
  const [lengthSeconds, setLengthSeconds] = useState(30);
  const [pacing, setPacing] = useState<'slow' | 'medium' | 'fast'>('medium');
  const [variationCount, setVariationCount] = useState(5);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setSubmitting(true);
    setErrors([]);

    const clips = [];
    for (const file of files) {
      const presignRes = await fetch('/api/uploads/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType: file.type }),
      });
      const { url, storageKey } = await presignRes.json();
      await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      clips.push({ storageKey, originalFilename: file.name });
    }

    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productName,
        sizingOverlayEnabled: sizingOn,
        sizeWorn: sizingOn ? sizeWorn : undefined,
        lengthSeconds,
        pacing,
        variationCount,
        clips,
      }),
    });

    if (!res.ok) {
      const body = await res.json();
      setErrors(body.errors ?? [{ field: 'form', message: 'Something went wrong.' }]);
      setSubmitting(false);
      return;
    }

    router.push('/jobs');
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

      <label>
        Pacing
        <select value={pacing} onChange={(e) => setPacing(e.target.value as typeof pacing)}>
          <option value="slow">Slow</option>
          <option value="medium">Medium</option>
          <option value="fast">Fast</option>
        </select>
      </label>

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

- [ ] **Step 8: Manual verification**

1. `npm run dev`, sign in, go to `http://localhost:3000/jobs/new`.
2. Select 2-3 short video files, type a product name, leave sizing off, pick a length and pacing, set variations to 3, click Create.
3. In Supabase's table editor, confirm a new row in `jobs` with your values, and matching rows in `raw_clips` (one per file).
4. In the Cloudflare R2 bucket, confirm the uploaded files appear under the `clips/` prefix.
5. Try submitting with sizing info turned on but no size entered — confirm you see the "Size worn is required" error and nothing gets created.

- [ ] **Step 9: Commit**

```bash
git add lib/validation db/repositories/jobs.ts app/api/jobs app/jobs/new tests/lib/validation
git commit -m "feat: add job creation flow with validation and clip upload"
```

---

## Task 7: Job list page

**Files:**
- Modify: `db/repositories/jobs.ts`
- Create: `app/api/jobs/route.ts` (add GET), `app/jobs/page.tsx`
- Test: `tests/db/repositories/jobs.test.ts`

**Interfaces:**
- Consumes: `createJob`, `CreateJobInput` (Task 6), `getCreatorByClerkId` (Task 3)
- Produces: `listJobsForCreator(creatorId: string): Promise<Job[]>` — used by Stage 3's gallery view as the basis for showing render status per job.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/repositories/jobs.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { creators, jobs } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob, listJobsForCreator } from '@/db/repositories/jobs';

describe('listJobsForCreator', () => {
  const CLERK_ID = 'test_clerk_user_jobs';

  beforeEach(async () => {
    await db.delete(creators).where(eq(creators.clerkUserId, CLERK_ID));
  });

  it('returns jobs belonging to the given creator, most recent first', async () => {
    const creator = await createCreatorIfNotExists(CLERK_ID);

    await createJob({
      creatorId: creator.id,
      productName: 'First Product',
      sizingOverlayEnabled: false,
      lengthSeconds: 30,
      pacing: 'medium',
      variationCount: 3,
      clips: [],
    });
    await createJob({
      creatorId: creator.id,
      productName: 'Second Product',
      sizingOverlayEnabled: false,
      lengthSeconds: 15,
      pacing: 'fast',
      variationCount: 5,
      clips: [],
    });

    const result = await listJobsForCreator(creator.id);

    expect(result).toHaveLength(2);
    expect(result[0].productName).toBe('Second Product');
    expect(result[1].productName).toBe('First Product');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/db/repositories/jobs.test.ts`
Expected: FAIL — `listJobsForCreator` is not exported.

- [ ] **Step 3: Implement `listJobsForCreator`**

```typescript
// db/repositories/jobs.ts — add
import { desc, eq } from 'drizzle-orm';

export async function listJobsForCreator(creatorId: string) {
  return db.query.jobs.findMany({
    where: eq(jobs.creatorId, creatorId),
    orderBy: desc(jobs.createdAt),
  });
}
```

(Adjust the existing `import { db } from '@/db/client';` block to also pull in `desc` and `eq` from `drizzle-orm`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/db/repositories/jobs.test.ts`
Expected: PASS

- [ ] **Step 5: Add the GET handler to the jobs API route**

```typescript
// app/api/jobs/route.ts — add alongside the existing POST
import { listJobsForCreator } from '@/db/repositories/jobs';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const creator = await getCreatorByClerkId(userId);
  if (!creator) return new Response('Creator profile not found', { status: 404 });

  const jobs = await listJobsForCreator(creator.id);
  return Response.json(jobs);
}
```

- [ ] **Step 6: Add the job list page**

```tsx
// app/jobs/page.tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type Job = {
  id: string;
  productName: string;
  status: string;
  lengthSeconds: number;
  pacing: string;
  variationCount: number;
  createdAt: string;
};

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    fetch('/api/jobs')
      .then((res) => res.json())
      .then(setJobs);
  }, []);

  return (
    <main>
      <h1>Your Videos</h1>
      <Link href="/jobs/new">+ New Video</Link>
      <ul>
        {jobs.map((job) => (
          <li key={job.id}>
            {job.productName} — {job.lengthSeconds}s, {job.pacing} pacing, {job.variationCount} variations —{' '}
            {job.status}
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 7: Manual verification**

1. `npm run dev`, sign in, go to `http://localhost:3000/jobs`.
2. Confirm the job you created in Task 6's manual verification appears in the list with the correct product name, length, pacing, and variation count.
3. Click "+ New Video," create a second job, and confirm both appear with the newest first.

- [ ] **Step 8: Commit**

```bash
git add db/repositories/jobs.ts app/api/jobs app/jobs/page.tsx tests/db/repositories/jobs.test.ts
git commit -m "feat: add job list page"
```

---

## Self-Review Notes

- **Spec coverage:** account/profile (Task 3-4), upload + job settings incl. length/pacing/variation count/sizing toggle+size-worn (Task 6), segment-level/AI/rendering intentionally excluded — that's Stage 2 and 3. Matches spec's Stage 1 boundary.
- **No placeholders:** every step has real, runnable code or exact manual instructions.
- **Type consistency:** `Creator` (from `creators` table), `Job` (from `jobs` table), `CreateJobInput`, and `JobValidationError` are defined once (Tasks 2, 6) and referenced by name in later tasks without redefinition drift.
