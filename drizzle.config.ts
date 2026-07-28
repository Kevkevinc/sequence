import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs as a standalone CLI script and does not get the automatic
// .env.local loading that `next` provides, so load it explicitly here.
// `quiet: true` suppresses dotenv's informational banner from CLI output.
config({ path: '.env.local', quiet: true });

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Read directly from process.env (not lib/env.ts's getRequiredEnv) is
    // intentional here: this file is a CLI-only, build-time config consumed
    // by the drizzle-kit tool itself, not app runtime code, so it's exempt
    // from the "always use getRequiredEnv" convention that applies to code
    // running inside the Next.js app.
    url: process.env.DATABASE_URL!,
  },
});
