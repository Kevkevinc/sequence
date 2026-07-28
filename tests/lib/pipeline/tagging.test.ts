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

vi.mock('@/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage')>();
  return {
    ...actual,
    getClipBuffer: vi.fn(async () => ({ buffer: Buffer.from('fake'), contentType: 'video/mp4' })),
  };
});

import { db } from '@/db/client';
import { rawClips, segments } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { tagClip } from '@/lib/pipeline/tagging';

describe('tagClip', () => {
  const CLERK_ID = 'test_clerk_user_tagging';
  let rawClipId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const creator = await createCreatorIfNotExists(CLERK_ID);
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

  it('uploads the clip bytes as a Blob carrying the storage content type', async () => {
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
    // The SDK rejects a raw Buffer, so the clip bytes must arrive as a Blob.
    expect(uploadArg.file).toBeInstanceOf(Blob);
    expect((uploadArg.file as Blob).type).toBe('video/mp4');
    expect(await (uploadArg.file as Blob).text()).toBe('fake');
    expect(uploadArg.config).toEqual({ mimeType: 'video/mp4' });
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
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      if (!result.success) {
        expect(result.error).toContain('still failed after 3 attempts');
        // The original cause has to survive for the failure to be diagnosable.
        expect(result.error).toContain('high demand');
      }
      const saved = await db.select().from(segments).where(eq(segments.rawClipId, rawClipId));
      expect(saved).toHaveLength(0);
    });
  });
});
