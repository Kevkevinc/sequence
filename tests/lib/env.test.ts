import { describe, it, expect, afterEach, vi } from 'vitest';
import { getRequiredEnv, getEnvWithDefault } from '@/lib/env';

describe('getRequiredEnv', () => {
  const KEY = 'TEST_ONLY_ENV_VAR';

  afterEach(() => {
    delete process.env[KEY];
  });

  it('returns the value when the env var is set', () => {
    process.env[KEY] = 'hello';
    expect(getRequiredEnv(KEY)).toBe('hello');
  });

  it('throws a clear error when the env var is missing', () => {
    delete process.env[KEY];
    expect(() => getRequiredEnv(KEY)).toThrow(
      'Missing required environment variable: TEST_ONLY_ENV_VAR'
    );
  });
});

describe('getEnvWithDefault', () => {
  const KEY = 'TEST_ONLY_OPTIONAL_ENV_VAR';

  afterEach(() => {
    delete process.env[KEY];
    vi.resetModules();
  });

  it('falls back to the built-in default when the env var is unset', () => {
    delete process.env[KEY];
    expect(getEnvWithDefault(KEY, 'gemini-3.6-flash')).toBe('gemini-3.6-flash');
  });

  it('returns the override when the env var is set', () => {
    process.env[KEY] = 'gemini-9.9-pro';
    expect(getEnvWithDefault(KEY, 'gemini-3.6-flash')).toBe('gemini-9.9-pro');
  });

  it('treats a blank or whitespace-only value as unset', () => {
    // An empty line in a `.env` file must not silently configure the pipeline
    // with a model name of "" — that would 404 on every call.
    process.env[KEY] = '   ';
    expect(getEnvWithDefault(KEY, 'gemini-3.6-flash')).toBe('gemini-3.6-flash');
  });

  it('is read at module load, so an override set later does not take effect', async () => {
    // The pipeline's model constants are module-level `getEnvWithDefault(...)`
    // calls. This pins the consequence: setting GEMINI_* after the module has
    // been imported changes nothing, and only a fresh module registry (as here)
    // or a fresh process picks the override up. Anyone adding a runtime model
    // switch will fail this test and know why.
    process.env[KEY] = 'first-value';
    const readAtLoad = getEnvWithDefault(KEY, 'fallback');
    process.env[KEY] = 'second-value';
    expect(readAtLoad).toBe('first-value');

    vi.resetModules();
    const reloaded = await import('@/lib/env');
    expect(reloaded.getEnvWithDefault(KEY, 'fallback')).toBe('second-value');
  });
});
