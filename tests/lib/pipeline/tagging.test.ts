import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

const mockUpload = vi.fn();
const mockGenerateContent = vi.fn();
const mockGetFile = vi.fn();

vi.mock('@/lib/gemini/client', () => ({
  getGeminiClient: () => ({
    files: { upload: mockUpload, get: mockGetFile },
    models: { generateContent: mockGenerateContent },
  }),
}));

const mockCleanUp = vi.fn(async () => {});

/*
 * The downloaded clip is a stand-in path, so its duration has to be one too.
 *
 * Without this the whole suite stopped at `ffprobe failed for /tmp/ugc-clip-fake`
 * the moment tagging started measuring clips — seven tests passing on a file
 * that never existed, then failing for a reason that had nothing to do with what
 * they were testing. Stating the duration outright also lets a test say what the
 * clip is and check what the tagger does with the model's timings against it.
 */
const CLIP_DURATION_SECONDS = 30;

vi.mock('@/lib/render/ffmpeg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/render/ffmpeg')>();
  return {
    ...actual,
    probeMedia: vi.fn(async () => ({
      video: { width: 1080, height: 1920, duration: CLIP_DURATION_SECONDS },
      audio: { duration: CLIP_DURATION_SECONDS },
      containerDuration: CLIP_DURATION_SECONDS,
    })),
  };
});

vi.mock('@/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage')>();
  return {
    ...actual,
    downloadClipToTempFile: vi.fn(async () => ({
      path: '/tmp/ugc-clip-fake',
      contentType: 'video/mp4',
      cleanUp: mockCleanUp,
    })),
  };
});

import { db } from '@/db/client';
import { rawClips, segments } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { tagClip } from '@/lib/pipeline/tagging';
import { cleanUpCreatorJobs } from '../../helpers/db-cleanup';

describe('tagClip', () => {
  const CLERK_ID = 'test_clerk_user_tagging';
  let creatorId: string;
  let rawClipId: string;

  afterEach(async () => {
    await cleanUpCreatorJobs(creatorId);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const creator = await createCreatorIfNotExists(CLERK_ID);
    creatorId = creator.id;
    const job = await createJob({
      creatorId: creator.id,
      productName: 'Test Product',
      sizingOverlayEnabled: false,
      lengthSeconds: 30,
      pacing: 'medium',
      variationCount: 3,
      clips: [{ storageKey: 'clips/test.mp4', originalFilename: 'test.mp4' }],
    });
    const [clip] = await db.select().from(rawClips).where(eq(rawClips.jobId, job.id));
    rawClipId = clip.id;
    await db.delete(segments).where(eq(segments.rawClipId, rawClipId));
  });

  it('uploads the clip to Gemini, parses candidate segments, and saves them', async () => {
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        segments: [
          { startSeconds: 0, endSeconds: 8, contentTag: 'whole-clip', qualityTag: 'medium' },
          { startSeconds: 2, endSeconds: 5, contentTag: 'try-on', qualityTag: 'high' },
        ],
      }),
    });

    const result = await tagClip(rawClipId);

    expect(result).toEqual({ success: true, segmentCount: 2 });

    const saved = await db.select().from(segments).where(eq(segments.rawClipId, rawClipId));
    expect(saved).toHaveLength(2);
    expect(saved.map((s) => s.contentTag)).toEqual(expect.arrayContaining(['whole-clip', 'try-on']));
  });

  it('uploads the clip from a temp file path rather than buffering it in memory', async () => {
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        segments: [{ startSeconds: 0, endSeconds: 8, contentTag: 'whole-clip', qualityTag: 'medium' }],
      }),
    });

    await tagClip(rawClipId);

    expect(mockUpload).toHaveBeenCalledTimes(1);
    const uploadArg = mockUpload.mock.calls[0][0];
    // A path, not a Blob: raw phone clips run to hundreds of megabytes and the
    // Blob form held each one three times over in the heap.
    expect(uploadArg.file).toBe('/tmp/ugc-clip-fake');
    expect(uploadArg.config).toEqual({ mimeType: 'video/mp4' });
  });

  it('removes the downloaded temp file once the clip is tagged', async () => {
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        segments: [{ startSeconds: 0, endSeconds: 8, contentTag: 'whole-clip', qualityTag: 'medium' }],
      }),
    });

    await tagClip(rawClipId);

    expect(mockCleanUp).toHaveBeenCalledTimes(1);
  });

  it('removes the downloaded temp file even when the model returns junk', async () => {
    // The early `return` inside the try block is exactly the path a naive
    // cleanup call at the end would miss, filling the worker's disk over time.
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({ text: 'not valid json' });

    const result = await tagClip(rawClipId);

    expect(result.success).toBe(false);
    expect(mockCleanUp).toHaveBeenCalledTimes(1);
  });

  it('asks the configured model for JSON, referencing the uploaded file', async () => {
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        segments: [{ startSeconds: 0, endSeconds: 8, contentTag: 'whole-clip', qualityTag: 'medium' }],
      }),
    });

    await tagClip(rawClipId);

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.6-flash',
        config: expect.objectContaining({ responseMimeType: 'application/json' }),
        contents: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            parts: expect.arrayContaining([
              expect.objectContaining({
                fileData: { fileUri: 'https://files/abc', mimeType: 'video/mp4' },
              }),
            ]),
          }),
        ]),
      })
    );
  });

  it('keeps the camera handling at each end out of the stored segments', async () => {
    /*
     * A creator's finished videos showed him reaching for the record button and
     * walking up to stop it. Two things put it there: nothing told the tagger
     * that moment was unusable, and the prompt required a whole-clip segment
     * spanning zero to the full duration — which handed the planner the reach
     * and the walk-up whatever the model thought of them.
     *
     * So the model reports where the real footage starts and ends, and nothing
     * outside that window is stored, including the whole-clip segment.
     */
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        usableStartSeconds: 1.5,
        usableEndSeconds: 27.5,
        segments: [
          { startSeconds: 0, endSeconds: 30, contentTag: 'whole-clip', qualityTag: 'medium' },
          { startSeconds: 0, endSeconds: 1.2, contentTag: 'other', qualityTag: 'low' },
          { startSeconds: 6, endSeconds: 10, contentTag: 'try-on', qualityTag: 'high' },
          { startSeconds: 28, endSeconds: 30, contentTag: 'other', qualityTag: 'low' },
        ],
      }),
    });

    const result = await tagClip(rawClipId);
    expect(result).toEqual({ success: true, segmentCount: 2 });

    const stored = await db.select().from(segments).where(eq(segments.rawClipId, rawClipId));
    const times = stored
      .map((row) => [Number(row.startSeconds), Number(row.endSeconds)] as const)
      .sort((a, b) => a[0] - b[0]);

    // The whole-clip fallback survives, pulled inside the window rather than
    // dropped — the planner leans on it when the granular segments run out.
    expect(times[0]).toEqual([1.5, 27.5]);
    expect(times[1]).toEqual([6, 10]);
  });

  it('stores the whole clip when the tagger reports no camera handling', async () => {
    // The behaviour every clip had before the window existed. A clip that opens
    // and closes on usable footage must not lose anything to this.
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        usableStartSeconds: 0,
        usableEndSeconds: 30,
        segments: [
          { startSeconds: 0, endSeconds: 30, contentTag: 'whole-clip', qualityTag: 'medium' },
          { startSeconds: 2, endSeconds: 6, contentTag: 'try-on', qualityTag: 'high' },
        ],
      }),
    });

    expect(await tagClip(rawClipId)).toEqual({ success: true, segmentCount: 2 });
    const stored = await db.select().from(segments).where(eq(segments.rawClipId, rawClipId));
    expect(stored.some((row) => Number(row.startSeconds) === 0 && Number(row.endSeconds) === 30)).toBe(
      true
    );
  });

  it('replaces existing segments instead of duplicating them when re-run', async () => {
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        segments: [
          { startSeconds: 0, endSeconds: 8, contentTag: 'whole-clip', qualityTag: 'medium' },
          { startSeconds: 2, endSeconds: 5, contentTag: 'try-on', qualityTag: 'high' },
        ],
      }),
    });

    await tagClip(rawClipId);
    const second = await tagClip(rawClipId);

    expect(second).toEqual({ success: true, segmentCount: 2 });
    const saved = await db.select().from(segments).where(eq(segments.rawClipId, rawClipId));
    expect(saved).toHaveLength(2);
  });

  it('rejects segments whose end time is not after their start time', async () => {
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        segments: [{ startSeconds: 5, endSeconds: 5, contentTag: 'whole-clip', qualityTag: 'medium' }],
      }),
    });

    const result = await tagClip(rawClipId);

    expect(result.success).toBe(false);
    if (!result.success) {
      // The specific validation cause must survive into the error string, so
      // later tasks can diagnose real model drift.
      expect(result.error).toContain('endSeconds must be greater than startSeconds');
    }

    const saved = await db.select().from(segments).where(eq(segments.rawClipId, rawClipId));
    expect(saved).toHaveLength(0);
  });

  it('returns a failure result instead of throwing when Gemini returns invalid JSON', async () => {
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({ text: 'not valid json' });

    const result = await tagClip(rawClipId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Gemini');
      // Detail from the underlying parse error must be appended, not swallowed.
      expect(result.error).toMatch(/Gemini returned invalid or unparseable JSON for tagging: .+/);
    }
  });

  it('accepts a bare segment array, not just the {segments: [...]} wrapper', async () => {
    // Observed live: on a real 30s+ clip the model returned the bare array
    // instead of the requested wrapper, dropping the job's most useful clip.
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify([
        { startSeconds: 0, endSeconds: 34, contentTag: 'whole-clip', qualityTag: 'high' },
        { startSeconds: 4, endSeconds: 9, contentTag: 'try-on', qualityTag: 'high' },
      ]),
    });

    const result = await tagClip(rawClipId);

    expect(result).toEqual({ success: true, segmentCount: 2 });

    const saved = await db.select().from(segments).where(eq(segments.rawClipId, rawClipId));
    expect(saved).toHaveLength(2);
    expect(saved.map((s) => s.contentTag).sort()).toEqual(['try-on', 'whole-clip']);
  });

  it('returns a failure result instead of throwing when the raw clip does not exist', async () => {
    const result = await tagClip('00000000-0000-0000-0000-000000000000');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('00000000-0000-0000-0000-000000000000');
    }
  });

  it('waits for the uploaded file to become ACTIVE before generating content', async () => {
    mockUpload.mockResolvedValue({ name: 'files/pending', uri: 'https://files/pending', mimeType: 'video/mp4', state: 'PROCESSING' });
    mockGetFile.mockResolvedValueOnce({ state: 'PROCESSING' }).mockResolvedValueOnce({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        segments: [{ startSeconds: 0, endSeconds: 8, contentTag: 'whole-clip', qualityTag: 'medium' }],
      }),
    });

    const result = await tagClip(rawClipId);

    expect(result).toEqual({ success: true, segmentCount: 1 });
    expect(mockGetFile).toHaveBeenCalledWith({ name: 'files/pending' });
    expect(mockGetFile.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('returns a failure result instead of throwing when Gemini file processing fails', async () => {
    mockUpload.mockResolvedValue({ name: 'files/bad', uri: 'https://files/bad', mimeType: 'video/mp4', state: 'PROCESSING' });
    mockGetFile.mockResolvedValue({ state: 'FAILED' });

    const result = await tagClip(rawClipId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Gemini');
    }
  });

  describe('transient Gemini failures', () => {
    /** The exact error that dropped three of six clips on the first live run. */
    function highDemand503() {
      return Object.assign(
        new Error(
          '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'
        ),
        { status: 503 }
      );
    }

    function goodResponse() {
      return {
        text: JSON.stringify({
          segments: [{ startSeconds: 0, endSeconds: 8, contentTag: 'whole-clip', qualityTag: 'medium' }],
        }),
      };
    }

    beforeEach(() => {
      // The retry path logs every backoff; silence it so the suite output stays
      // readable, and so the assertions below are about behaviour, not noise.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
      mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('retries a 503 high-demand failure and saves the segments from the retry', async () => {
      mockGenerateContent.mockRejectedValueOnce(highDemand503()).mockResolvedValue(goodResponse());

      const result = await tagClip(rawClipId);

      expect(result).toEqual({ success: true, segmentCount: 1 });
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      const saved = await db.select().from(segments).where(eq(segments.rawClipId, rawClipId));
      expect(saved).toHaveLength(1);
    });

    it('retries a transient failure raised by the upload, not just the generate call', async () => {
      // A demand spike can land anywhere in the exchange, and a retry that
      // reused the failed upload would have nothing to reference.
      mockUpload
        .mockRejectedValueOnce(highDemand503())
        .mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
      mockGenerateContent.mockResolvedValue(goodResponse());

      const result = await tagClip(rawClipId);

      expect(result).toEqual({ success: true, segmentCount: 1 });
      expect(mockUpload).toHaveBeenCalledTimes(2);
    });

    it('retries a network-level failure', async () => {
      mockGenerateContent
        .mockRejectedValueOnce(
          new Error('fetch failed', {
            cause: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }),
          })
        )
        .mockResolvedValue(goodResponse());

      const result = await tagClip(rawClipId);

      expect(result).toEqual({ success: true, segmentCount: 1 });
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('does not retry a terminal 404 model-not-found failure', async () => {
      mockGenerateContent.mockRejectedValue(
        Object.assign(new Error('models/gemini-nope is not found for API version v1beta'), { status: 404 })
      );

      const result = await tagClip(rawClipId);

      expect(result.success).toBe(false);
      // Retrying a bad model name only delays the same failure.
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      if (!result.success) expect(result.error).toContain('is not found');
    });

    it('does not retry a schema failure, which a re-roll would not fix', async () => {
      mockGenerateContent.mockResolvedValue({ text: 'not valid json' });

      const result = await tagClip(rawClipId);

      expect(result.success).toBe(false);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('gives up after the retry budget with an error saying it was retried', async () => {
      mockGenerateContent.mockRejectedValue(highDemand503());

      const result = await tagClip(rawClipId);

      expect(result.success).toBe(false);
      expect(mockGenerateContent).toHaveBeenCalledTimes(5);
      if (!result.success) {
        expect(result.error).toContain('still failed after 5 attempts');
        // The original cause has to survive for the failure to be diagnosable.
        expect(result.error).toContain('high demand');
      }
      const saved = await db.select().from(segments).where(eq(segments.rawClipId, rawClipId));
      expect(saved).toHaveLength(0);
    }, 30_000); // 5 attempts back off to ~15s of real waiting
  });
});
