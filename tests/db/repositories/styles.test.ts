import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { styles } from '@/db/schema';
import { listStyles, getStyleById } from '@/db/repositories/styles';
import { seedBuiltInStyles } from '@/db/seed-styles';

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

describe('seedBuiltInStyles', () => {
  it('creates the two v1 styles with their real derived config, and is idempotent', async () => {
    await seedBuiltInStyles();
    await seedBuiltInStyles(); // running it twice must not duplicate rows

    const all = await listStyles();
    const mixedCuts = all.find((s) => s.name === 'Mixed Cuts');
    const dupeFlip = all.find((s) => s.name === 'Dupe Flip');

    expect(all.filter((s) => s.name === 'Mixed Cuts')).toHaveLength(1);
    expect(all.filter((s) => s.name === 'Dupe Flip')).toHaveLength(1);

    expect(mixedCuts?.config).toMatchObject({
      cutMinSeconds: 2.5,
      cutMaxSeconds: 4,
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
