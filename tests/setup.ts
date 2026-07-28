import { config } from 'dotenv';

// Vitest (unlike `next`) does not automatically load .env.local into
// process.env, so load it explicitly for tests that need real config
// (e.g. DATABASE_URL for the database schema test).
config({ path: '.env.local' });

process.env.R2_ACCOUNT_ID ||= 'test-account-id';
process.env.R2_ACCESS_KEY_ID ||= 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY ||= 'test-secret-key';
process.env.R2_BUCKET_NAME ||= 'test-bucket';
