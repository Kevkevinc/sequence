import { config } from 'dotenv';

// Fake R2 defaults must be set BEFORE loading .env.local below. dotenv does
// not overwrite variables that are already present in process.env, so
// setting these first guarantees tests always see fake R2 credentials, even
// once .env.local defines real R2_* values (e.g. once Task 5 adds them).
// If these ran after the dotenv load, `||=` would become a no-op whenever
// .env.local already set the var, silently running tests against real
// credentials/endpoints instead of the fakes.
process.env.R2_ACCOUNT_ID ||= 'test-account-id';
process.env.R2_ACCESS_KEY_ID ||= 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY ||= 'test-secret-key';
process.env.R2_BUCKET_NAME ||= 'test-bucket';

// Vitest (unlike `next`) does not automatically load .env.local into
// process.env, so load it explicitly for tests that need real config
// (e.g. DATABASE_URL for the database schema test). `quiet: true` suppresses
// dotenv's informational banner from every test run's output.
config({ path: '.env.local', quiet: true });
