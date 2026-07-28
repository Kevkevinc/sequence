import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('returns a failure result instead of throwing when Gemini returns invalid JSON', async () => {
    mockUpload.mockResolvedValue({ name: 'files/abc', uri: 'https://files/abc', mimeType: 'video/mp4', state: 'ACTIVE' });
    mockGetFile.mockResolvedValue({ state: 'ACTIVE' });
    mockGenerateContent.mockResolvedValue({ text: 'not valid json' });

    const result = await tagClip(rawClipId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Gemini');
    }
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
});
