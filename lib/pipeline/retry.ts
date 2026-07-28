import { describeCause } from '@/lib/pipeline/errors';

/**
 * Retrying transient Gemini failures.
 *
 * The first live end-to-end run lost half a job's footage to a single
 * `503 UNAVAILABLE: "This model is currently experiencing high demand"` — an
 * error that would almost certainly have succeeded on a second try, but which
 * the pipeline treated as terminal and dropped the clip for.
 *
 * The rule here is deliberately conservative: an error is retried only when it
 * is *recognisably* a "the service was busy / the wire broke" failure. Anything
 * unrecognised (a bad model name, a malformed request, a bad API key, our own
 * validation errors) is terminal, because retrying those just wastes wall-clock
 * time and still fails.
 */

/** HTTP statuses where the request was fine and the service was not. */
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Google's canonical status names for the same conditions. Matched
 * case-sensitively against the message, so an ordinary 400 whose prose happens
 * to contain the word "unavailable" is not mistaken for a `503 UNAVAILABLE`.
 */
const TRANSIENT_STATUS_NAME = /\b(UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|INTERNAL|ABORTED)\b/;

/** A status code embedded in an error body we could not read structurally. */
const TRANSIENT_EMBEDDED_CODE = /"code"\s*:\s*(?:408|429|500|502|503|504)\b/;

/** Wire-level failures, which say nothing about whether the request was valid. */
const TRANSIENT_MESSAGE = /\b(fetch failed|socket hang up|network error|timed?\s?out|overloaded|high demand|try again later|connection (?:reset|closed))\b/i;

/**
 * A quota violation whose window is a *day*, not a minute.
 *
 * 429 covers two very different conditions. A per-minute rate limit clears in
 * seconds and is exactly what the backoff below is for. A per-day quota does
 * not clear until midnight Pacific, and on this project's free tier (20
 * requests per day per model) it is the common one. Retrying it costs three
 * attempts plus backoff and fails identically every time — and because
 * `planJob` chains MAX_ATTEMPTS x DIRECTOR_RETRY, a single exhausted daily
 * quota could burn up to nine calls against a 20-a-day budget.
 *
 * Google names the offending quota in the error body's `QuotaFailure` detail,
 * e.g. `"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"`.
 */
const DAILY_QUOTA_MARKER = /per[\s_-]?day/i;

/** Google's `RetryInfo` detail, e.g. `"retryDelay": "37s"`. */
const RETRY_DELAY_PATTERN = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/i;

/**
 * Longest `RetryInfo.retryDelay` worth waiting out. Above this the service is
 * telling us the condition is not a spike, and our whole budget (three tries,
 * ~3s of backoff) cannot span it, so retrying is theatre.
 */
const MAX_HONOURED_RETRY_DELAY_SECONDS = 60;

/** Whether an error is recognisably about quota at all. */
const QUOTA_SHAPED = /RESOURCE_EXHAUSTED|quota/i;

/** Node/undici error codes for a connection that never worked or died mid-flight. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** How far down an error's `cause` chain to look before giving up. */
const MAX_CAUSE_DEPTH = 5;

export type TransientRetryOptions = {
  /** Total tries, including the first. */
  attempts: number;
  /** Base for the exponential backoff; the real wait is jittered around it. */
  baseDelayMs: number;
  /** Ceiling on a single wait, so a long retry chain cannot stall a job. */
  maxDelayMs?: number;
  /** Names the operation in log lines and in the final error message. */
  label: string;
};

const DEFAULT_MAX_DELAY_MS = 8000;

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < MAX_CAUSE_DEPTH; depth++) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * The HTTP status the API reported, if it reported one. `@google/genai`'s
 * `ApiError` carries it as a number on `status`; other clients use `code`.
 * Node's network errors use `code` for a *string* like `ECONNRESET`, which the
 * type check deliberately excludes here.
 */
function httpStatusOf(error: unknown): number | undefined {
  for (const link of causeChain(error)) {
    if (typeof link !== 'object' || link === null) continue;
    const candidate = link as { status?: unknown; code?: unknown };
    if (typeof candidate.status === 'number') return candidate.status;
    if (typeof candidate.code === 'number') return candidate.code;
  }
  return undefined;
}

function networkCodesOf(error: unknown): string[] {
  return causeChain(error)
    .map((link) => (link as { code?: unknown })?.code)
    .filter((code): code is string => typeof code === 'string');
}

function messagesOf(error: unknown): string {
  return causeChain(error)
    .map((link) => (link instanceof Error ? link.message : String(link)))
    .join(' | ');
}

/**
 * True when a 429 is a *daily* quota exhaustion rather than a rate limit.
 *
 * Deliberately gated on the error looking like a quota failure at all, so an
 * unrelated 503 whose prose happens to say "per day" is not misread. The
 * quota-id check comes first because Google returns a short `retryDelay`
 * (~30s) alongside a per-day `quotaId` — honouring the delay alone would keep
 * retrying an exhausted daily quota.
 */
export function isExhaustedDailyQuota(error: unknown): boolean {
  const status = httpStatusOf(error);
  const message = messagesOf(error);
  if (status !== 429 && !QUOTA_SHAPED.test(message)) return false;

  if (DAILY_QUOTA_MARKER.test(message)) return true;

  const retryDelay = RETRY_DELAY_PATTERN.exec(message);
  return retryDelay !== null && Number(retryDelay[1]) > MAX_HONOURED_RETRY_DELAY_SECONDS;
}

/**
 * True for "the service was busy or the wire broke", false for everything else.
 *
 * An explicit HTTP status is authoritative: a 404 (model not found) or 400
 * (malformed request) is terminal no matter what its prose says, so a status we
 * recognise short-circuits the text heuristics below it.
 */
export function isTransientError(error: unknown): boolean {
  // Checked before the status table, because 429 is in it and a spent daily
  // quota is the one 429 that a retry cannot possibly fix.
  if (isExhaustedDailyQuota(error)) return false;

  const status = httpStatusOf(error);
  if (status !== undefined) return TRANSIENT_HTTP_STATUSES.has(status);

  if (networkCodesOf(error).some((code) => TRANSIENT_NETWORK_CODES.has(code))) return true;

  const message = messagesOf(error);
  return (
    TRANSIENT_STATUS_NAME.test(message) ||
    TRANSIENT_EMBEDDED_CODE.test(message) ||
    TRANSIENT_MESSAGE.test(message)
  );
}

/**
 * Exponential backoff with jitter, between half and all of the exponential
 * step. The jitter matters because a job tags every clip in parallel: without
 * it, six clips that all hit the same demand spike would retry in lockstep and
 * collide again.
 */
function backoffDelayMs(attemptIndex: number, baseDelayMs: number, maxDelayMs: number): number {
  const step = Math.min(baseDelayMs * 2 ** attemptIndex, maxDelayMs);
  return step / 2 + Math.random() * (step / 2);
}

/**
 * Runs `operation`, retrying only transient failures, up to `attempts` tries.
 *
 * Terminal errors are rethrown untouched on the first try. Transient errors are
 * rethrown once the budget is spent, wrapped in a message that says plainly it
 * was retried and still failed, with the original kept as `cause`.
 */
export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options: TransientRetryOptions
): Promise<T> {
  const { attempts, baseDelayMs, label } = options;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientError(error)) throw error;

      lastError = error;
      const isLastAttempt = attempt === attempts - 1;
      if (isLastAttempt) break;

      const delay = backoffDelayMs(attempt, baseDelayMs, maxDelayMs);
      console.warn(
        `${label} hit a transient error (attempt ${attempt + 1} of ${attempts}), ` +
          `retrying in ${Math.round(delay)}ms: ${describeCause(error)}`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(
    `${label} still failed after ${attempts} attempts (transient errors were retried): ${describeCause(lastError)}`,
    { cause: lastError }
  );
}
