import { describe, it, expect, afterEach } from 'vitest';
import { getRequiredEnv } from '@/lib/env';

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
