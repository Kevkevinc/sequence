import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

describe('database schema', () => {
  it('creates the creators, jobs, raw_clips, segments, and edit_plans tables with expected columns', async () => {
    const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('creators', 'jobs', 'raw_clips', 'segments', 'edit_plans')
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
        'jobs.failure_reason',
        'raw_clips.storage_key',
        'raw_clips.original_filename',
        'raw_clips.job_id',
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
  });

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
});
