import { describe, it, expect } from 'vitest';
import { isTransientError } from '@/lib/pipeline/retry';

/**
 * The exact error that destroyed a tester's first talking-head job.
 *
 * Gemini returned a 500 five times while transcribing, the retry layer gave up,
 * and the job was marked failed permanently — the same recording transcribed
 * cleanly minutes later. The worker now requeues instead, but that only works
 * if this string is recognised as temporary, so it is pinned here verbatim.
 */
const REAL_FAILURE =
  'Could not transcribe the recording: Gemini transcription call still failed after 5 attempts ' +
  '(transient errors were retried): {"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}';

describe('the transcription outage that killed a live job', () => {
  it('is recognised as temporary, so the job is requeued rather than failed', () => {
    expect(isTransientError(REAL_FAILURE)).toBe(true);
  });

  it('still treats a real content problem as permanent', () => {
    // Requeuing these would spin the worker on a job that can never succeed.
    expect(
      isTransientError(
        'No speech was found in this recording. Talking mode needs a clip of you speaking to camera.'
      )
    ).toBe(false);
    expect(isTransientError('This job has no recording to edit.')).toBe(false);
  });

  it('does retry an ordinary rate limit, where backing off is the fix', () => {
    expect(
      isTransientError('{"error":{"code":429,"message":"Too many requests","status":"RESOURCE_EXHAUSTED"}}')
    ).toBe(true);
  });
});
