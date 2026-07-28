import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum, numeric, jsonb } from 'drizzle-orm/pg-core';

export const pacingEnum = pgEnum('pacing', ['slow', 'medium', 'fast']);
export const jobStatusEnum = pgEnum('job_status', ['pending', 'tagging', 'planning', 'planned', 'failed']);

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
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rawClips = pgTable('raw_clips', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  storageKey: text('storage_key').notNull(),
  originalFilename: text('original_filename').notNull(),
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
