import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum, numeric, jsonb } from 'drizzle-orm/pg-core';

export const pacingEnum = pgEnum('pacing', ['slow', 'medium', 'fast']);
export const jobStatusEnum = pgEnum('job_status', [
  'pending', 'tagging', 'planning', 'planned', 'rendering', 'done', 'failed',
]);
export const renderStatusEnum = pgEnum('render_status', ['rendering', 'done', 'failed']);

/**
 * Which editor a job goes through.
 *
 * `cuts` is the original silent pipeline: footage is tagged, re-sequenced into
 * several variations and delivered without audio for the creator to voice over.
 * `talking` is the opposite discipline — one recording of somebody speaking to
 * camera, tightened by removing the pauses, audio kept in sync, captions burned
 * on, and exactly one result because the audio pins the order of the cuts.
 *
 * A column rather than an inferred property: the two share uploads and storage
 * but almost nothing else, and every stage needs to know which it is running.
 */
export const jobKindEnum = pgEnum('job_kind', ['cuts', 'talking']);

/**
 * Which intake a creator arrived through. Recorded once, at sign-up, and never
 * rewritten: someone who joined during the beta stays a beta tester after the
 * doors open, which is the whole point of knowing.
 */
export const creatorCohortEnum = pgEnum('creator_cohort', ['beta', 'public']);

/**
 * Who the creator makes content for, used to pick the register of the burned-in
 * hook. `any` is the honest default: a neutral line never sounds wrong, and
 * guessing produces a menswear creator captioned in women's-content cadence,
 * which is the mismatch this exists to prevent.
 */
export const creatorAudienceEnum = pgEnum('creator_audience', ['mens', 'womens', 'any']);

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
  audience: creatorAudienceEnum('audience').notNull().default('any'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * The creator's own caption look, used as the starting point in Custom mode.
   *
   * Style mode takes its defaults from the style instead — a style is a look,
   * and picking one should bring its captions with it. This is the personal
   * default for jobs that are not following a style.
   */
  captionSettings: jsonb('caption_settings'),
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
  /**
   * How many times this job has been put back on the queue after a transient
   * failure. Bounds the requeue loop: without it, a model that is down for an
   * hour would cycle the same job forever.
   */
  attempts: integer('attempts').notNull().default(0),
  failureReason: text('failure_reason'),
  warning: text('warning'),
  /**
   * Caption look and position chosen for this job specifically.
   *
   * Null means "whatever the style or the creator's profile says", which is the
   * normal case — this only holds a value when the creator tweaked something on
   * the preview screen for this one video. Stored as jsonb and re-validated on
   * read (see lib/render/captionSettings.ts): the shape will grow, and a job
   * written before a field existed must keep rendering.
   */
  captionSettings: jsonb('caption_settings'),
  /**
   * Defaulted so every job written before talking mode existed reads as `cuts`,
   * which is what they are.
   */
  kind: jobKindEnum('kind').notNull().default('cuts'),
  /** What was said, stored once so a re-render never re-pays for transcription. */
  transcript: text('transcript'),
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
/**
 * What an inspiration image is, which decides how the renderer treats it.
 *
 * A `person` fit pic has its background removed so the figure floats over the
 * footage; a `listing` screenshot is composited untouched, because cutting its
 * background out would remove the white card and the price that are the point
 * of showing it.
 */
export const inspirationImageKindEnum = pgEnum('inspiration_image_kind', ['person', 'listing']);

export const jobInspirationImages = pgTable('job_inspiration_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  storageKey: text('storage_key').notNull(),
  kind: inspirationImageKindEnum('kind').notNull().default('person'),
  /** Order they appear on screen. Ascending, assigned at upload. */
  position: integer('position').notNull().default(0),
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
  /**
   * Nullable since talking mode.
   *
   * A talking-head render has no edit plan to point at: its cuts come from
   * measuring the audio rather than from a plan the director wrote, and there
   * is only ever one result. Everything else about the row — status, storage
   * key, duration, failure reason — means exactly what it does for a variation,
   * which is what lets both editors deliver through the same list.
   */
  editPlanId: uuid('edit_plan_id').references(() => editPlans.id),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  storageKey: text('storage_key'),
  durationSeconds: numeric('duration_seconds'),
  status: renderStatusEnum('status').notNull().default('rendering'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Which pipeline step spent a model call. Only these two exist today; both are
 * paid per token, and they have very different shapes — tagging sends a whole
 * video, planning sends text — so a single "gemini spend" number without this
 * split would hide which one is actually costing money.
 */
export const apiUsageKindEnum = pgEnum('api_usage_kind', ['tagging', 'planning']);

/**
 * One row per Gemini call, with the token counts the API itself reported.
 *
 * Recorded rather than estimated. Cost per job was previously guessed from call
 * counts, which cannot be right: a tagging call is billed by the duration of
 * the video it ingests, so two jobs with the same number of calls can differ by
 * an order of magnitude. The provider returns exact counts on every response —
 * this stores them so spend can be answered rather than approximated.
 *
 * `jobId` is nullable and not cascaded: usage is a financial record and has to
 * survive the job it belongs to being deleted. Writes are best-effort at the
 * call sites — failing a render because a metering row could not be written
 * would be a bad trade.
 */
export const apiUsage = pgTable('api_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id'),
  kind: apiUsageKindEnum('kind').notNull(),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Liveness for each worker process, refreshed on every poll.
 *
 * "Is the worker up?" could not be answered before without reading deploy logs,
 * and inferring it from recent job activity gives the wrong answer in exactly
 * the case that matters: an idle queue and a dead worker look identical. A
 * heartbeat separates them.
 *
 * Keyed by a per-process id so a restart or a second replica is visible as its
 * own row rather than silently overwriting another's timestamp.
 */
export const workerHeartbeats = pgTable('worker_heartbeats', {
  id: text('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  /** What the process is currently doing, for the dashboard's status line. */
  activity: text('activity'),
});
