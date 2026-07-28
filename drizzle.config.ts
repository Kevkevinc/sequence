import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs as a standalone CLI script and does not get the automatic
// .env.local loading that `next` provides, so load it explicitly here.
config({ path: '.env.local' });

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
