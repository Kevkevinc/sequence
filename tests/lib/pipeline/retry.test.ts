import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isExhaustedDailyQuota, isTransientError, withTransientRetry } from '@/lib/pipeline/retry';

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

/**
 * The free tier's real per-day exhaustion body, verbatim in shape: a
 * `QuotaFailure` naming a `...PerDay...` quota id, alongside a short
 * `RetryInfo.retryDelay` that is misleading — the quota does not come back for
 * hours.
 */
const DAILY_QUOTA_429 = apiError(
  429,
  '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests","quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaDimensions":{"model":"gemini-3.6-flash"},"quotaValue":"20"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}'
);

/** The other 429: a burst limit that genuinely clears in seconds. */
const PER_MINUTE_429 = apiError(
  429,
  '{"error":{"code":429,"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"11s"}]}'
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

describe('daily quota exhaustion, which no amount of retrying fixes', () => {
  it('treats a per-day quota 429 as terminal', () => {
    // The free tier is 20 requests per day per model. Retrying this costs three
    // attempts plus backoff and fails identically; worse, planJob chains its
    // retries, so one exhausted quota could burn nine of the day's twenty.
    expect(isExhaustedDailyQuota(DAILY_QUOTA_429)).toBe(true);
    expect(isTransientError(DAILY_QUOTA_429)).toBe(false);
  });

  it('still treats a per-minute rate-limit 429 as transient', () => {
    // The whole point of splitting the two: a burst limit clears in seconds and
    // is exactly what the backoff exists for.
    expect(isExhaustedDailyQuota(PER_MINUTE_429)).toBe(false);
    expect(isTransientError(PER_MINUTE_429)).toBe(true);
  });

  it('honours a long RetryInfo delay even when no quota id names a day', () => {
    const longWait = apiError(
      429,
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"1800s"}]}}'
    );
    // Half an hour is not a spike, and our entire budget is ~3 seconds.
    expect(isTransientError(longWait)).toBe(false);
  });

  it('keeps retrying when the service asks for a short wait', () => {
    const shortWait = apiError(
      429,
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"18s"}]}}'
    );
    expect(isTransientError(shortWait)).toBe(true);
  });

  it('does not misread an unrelated error that happens to mention a day', () => {
    // The veto is gated on the error looking like a quota failure at all, so a
    // 503 whose prose says "per day" stays retryable.
    const busy = apiError(503, 'This model is busy; usage resets per day but try again later');
    expect(isExhaustedDailyQuota(busy)).toBe(false);
    expect(isTransientError(busy)).toBe(true);
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

  it('spends no attempts and no backoff on an exhausted daily quota', async () => {
    const operation = vi.fn().mockRejectedValue(DAILY_QUOTA_429);

    await expect(withTransientRetry(operation, FAST)).rejects.toBe(DAILY_QUOTA_429);
    expect(operation).toHaveBeenCalledTimes(1);
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
