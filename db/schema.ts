import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum, numeric, jsonb } from 'drizzle-orm/pg-core';

export const pacingEnum = pgEnum('pacing', ['slow', 'medium', 'fast']);
export const jobStatusEnum = pgEnum('job_status', [
  'pending', 'tagging', 'planning', 'planned', 'rendering', 'done', 'failed',
]);
export const renderStatusEnum = pgEnum('render_status', ['rendering', 'done', 'failed']);

/**
 * Which intake a creator arrived through. Recorded once, at sign-up, and never
 * rewritten: someone who joined during the beta stays a beta tester after the
 * doors open, which is the whole point of knowing.
 */
export const creatorCohortEnum = pgEnum('creator_cohort', ['beta', 'public']);

export const creators = pgTable('creators', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  height: text('height'),
  weight: text('weight'),
  /*
   * Defaulted in the database rather than at the call site. Creator rows are
   * inserted from both the Clerk webhook and lazy provisioning, and a default
   * that lives in Postgres cannot be forgotten by a third path added later.
   * Opening to the public is then a one-line migration changing this default,
   * with everyone already labelled keeping their label.
   */
  cohort: creatorCohortEnum('cohort').notNull().default('beta'),
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
