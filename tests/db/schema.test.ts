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
