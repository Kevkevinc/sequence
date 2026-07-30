import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { styles } from '@/db/schema';

export async function listStyles() {
  return db.query.styles.findMany({ orderBy: (s, { asc }) => asc(s.createdAt) });
}

export async function getStyleById(id: string) {
  return db.query.styles.findFirst({ where: eq(styles.id, id) });
}
