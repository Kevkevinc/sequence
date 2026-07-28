import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTransientError, withTransientRetry } from '@/lib/pipeline/retry';

/** Shape of `@google/genai`'s ApiError: a numeric `status` plus the body text. */
function apiError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Shape of an undici network failure: a generic wrapper over a coded cause. */
function networkError(code: string): Error {
  return new Error('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) });
}

// The exact 503 that dropped three of six clips on the first live run.
const LIVE_503 = apiError(
  503,
  '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'
);

describe('isTransientError', () => {
  it.each([
    ['the live 503 UNAVAILABLE that dropped clips', LIVE_503],
    ['429 RESOURCE_EXHAUSTED', apiError(429, 'Resource has been exhausted (RESOURCE_EXHAUSTED)')],
    ['500 INTERNAL', apiError(500, 'internal error')],
    ['502 bad gateway', apiError(502, 'Bad Gateway')],
    ['504 gateway timeout', apiError(504, 'Gateway Timeout')],
    ['a reset connection', networkError('ECONNRESET')],
    ['a connect timeout', networkError('UND_ERR_CONNECT_TIMEOUT')],
    ['a transient DNS failure', networkError('EAI_AGAIN')],
    ['a bare fetch failure with no code', new Error('fetch failed')],
    ['a request that timed out', new Error('The operation timed out')],
    ['a status name with no numeric status', new Error('503 UNAVAILABLE: the model is overloaded')],
  ])('treats %s as transient', (_label, error) => {
    expect(isTransientError(error)).toBe(true);
  });

  it.each([
    ['404 model not found', apiError(404, 'models/gemini-x is not found for API version v1beta')],
    ['400 bad request', apiError(400, 'Invalid JSON payload received (INVALID_ARGUMENT)')],
    ['401 unauthenticated', apiError(401, 'API key not valid. Please pass a valid API key.')],
    ['403 permission denied', apiError(403, 'PERMISSION_DENIED: caller lacks permission')],
    ['a Zod validation failure', new Error('endSeconds must be greater than startSeconds')],
    ['our own file-processing failure', new Error('Gemini file processing failed')],
    ['our own file-activation timeout', new Error('Gemini file did not become ACTIVE in time')],
    ['an unrecognised error', new Error('something else entirely')],
  ])('treats %s as terminal', (_label, error) => {
    expect(isTransientError(error)).toBe(false);
  });

  it('lets an explicit terminal status win over transient-looking prose', () => {
    // A 400 that happens to mention being unavailable is still a bad request:
    // retrying it burns wall-clock time and fails identically every attempt.
    expect(isTransientError(apiError(400, 'that feature is unavailable for this model'))).toBe(false);
  });
});

describe('withTransientRetry', () => {
  // Real backoff would add seconds per case; the delay maths is exercised
  // separately by asserting the operation is actually re-run.
  const FAST = { attempts: 3, baseDelayMs: 0, label: 'Test call' };

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the result without retrying when the operation succeeds', async () => {
    const operation = vi.fn().mockResolvedValue('ok');

    await expect(withTransientRetry(operation, FAST)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and returns the eventual success', async () => {
    const operation = vi.fn().mockRejectedValueOnce(LIVE_503).mockResolvedValue('ok');

    await expect(withTransientRetry(operation, FAST)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('rethrows a terminal failure immediately, without spending an attempt', async () => {
    const terminal = apiError(404, 'models/gemini-x is not found');
    const operation = vi.fn().mockRejectedValue(terminal);

    await expect(withTransientRetry(operation, FAST)).rejects.toBe(terminal);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured attempts, saying it retried and still failed', async () => {
    const operation = vi.fn().mockRejectedValue(LIVE_503);

    await expect(withTransientRetry(operation, FAST)).rejects.toThrow(
      /Test call still failed after 3 attempts \(transient errors were retried\)/
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('keeps the underlying failure in the message and as the cause', async () => {
    const operation = vi.fn().mockRejectedValue(LIVE_503);

    let error: Error | undefined;
    try {
      await withTransientRetry(operation, FAST);
    } catch (thrown) {
      error = thrown as Error;
    }
    expect(error).toBeDefined();
    error = error!;

    // Without the original detail, a failed job says only "it was retried".
    expect(error.message).toContain('high demand');
    expect(error.cause).toBe(LIVE_503);
  });

  it('actually waits between attempts rather than hammering the API', async () => {
    const operation = vi.fn().mockRejectedValueOnce(LIVE_503).mockResolvedValue('ok');
    const startedAt = Date.now();

    await withTransientRetry(operation, { attempts: 3, baseDelayMs: 200, label: 'Test call' });

    // One retry at baseDelayMs 200 waits between 100ms and 200ms (half-jitter).
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
  });

  it('caps a single wait so a long retry chain cannot stall a job', async () => {
    const operation = vi.fn().mockRejectedValueOnce(LIVE_503).mockResolvedValue('ok');
    const startedAt = Date.now();

    await withTransientRetry(operation, {
      attempts: 3,
      baseDelayMs: 60_000,
      maxDelayMs: 100,
      label: 'Test call',
    });

    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
