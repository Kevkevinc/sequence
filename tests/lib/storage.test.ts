import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { Readable } from 'stream';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://example.com/signed-url'),
}));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: class {
      send = vi.fn(async (command: InstanceType<typeof actual.GetObjectCommand>) => {
        if (command instanceof actual.GetObjectCommand) {
          const stream = Readable.from([Buffer.from('fake-video-bytes')]);
          return { Body: stream, ContentType: 'video/mp4' };
        }
        throw new Error('unexpected command in test');
      });
    },
  };
});

import { createUploadUrl } from '@/lib/storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PutObjectCommand } from '@aws-sdk/client-s3';

describe('createUploadUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a signed URL and a storage key scoped under clips/', async () => {
    const result = await createUploadUrl('my-clip.mp4', 'video/mp4');
    expect(result.url).toBe('https://example.com/signed-url');
    expect(result.storageKey).toMatch(/^clips\/.+-my-clip\.mp4$/);
  });

  it('calls getSignedUrl with correct S3 command parameters', async () => {
    const filename = 'my-clip.mp4';
    const contentType = 'video/mp4';
    const result = await createUploadUrl(filename, contentType);

    // Verify getSignedUrl was called
    expect(getSignedUrl).toHaveBeenCalled();

    // Get the command object passed to getSignedUrl
    const calls = vi.mocked(getSignedUrl).mock.calls;
    expect(calls.length).toBeGreaterThan(0);

    const [, command] = calls[0];
    const { Bucket, Key, ContentType } = (command as PutObjectCommand).input;

    // Verify Bucket matches R2_BUCKET_NAME env var (test value is 'test-bucket')
    expect(Bucket).toBe('test-bucket');

    // Verify Key matches the returned storageKey
    expect(Key).toBe(result.storageKey);

    // Verify ContentType matches what was requested
    expect(ContentType).toBe(contentType);
  });
});

describe('getClipBuffer', () => {
  it('downloads and returns the clip as a buffer with its content type', async () => {
    const { getClipBuffer } = await import('@/lib/storage');
    const result = await getClipBuffer('clips/some-key.mp4');
    expect(result.buffer.toString()).toBe('fake-video-bytes');
    expect(result.contentType).toBe('video/mp4');
  });
});

describe('downloadClipToTempFile', () => {
  it('streams the clip to a temp file and reports its path and content type', async () => {
    const { downloadClipToTempFile } = await import('@/lib/storage');
    const clip = await downloadClipToTempFile('clips/some-key.mp4');

    try {
      // The point of this function: the SDK can upload straight from the path,
      // so a 200MB clip never lands in the process's heap.
      expect(clip.path).toContain(tmpdir());
      expect(readFileSync(clip.path).toString()).toBe('fake-video-bytes');
      expect(clip.contentType).toBe('video/mp4');
    } finally {
      await clip.cleanUp();
    }
  });

  it('removes the temp file on cleanUp, and tolerates being cleaned up twice', async () => {
    const { downloadClipToTempFile } = await import('@/lib/storage');
    const clip = await downloadClipToTempFile('clips/some-key.mp4');

    await clip.cleanUp();
    expect(existsSync(clip.path)).toBe(false);
    // A second cleanUp must not throw: it runs from a `finally` that may
    // already have run on an earlier error path.
    await expect(clip.cleanUp()).resolves.toBeUndefined();
  });

  it('gives every download its own path, so concurrent clips cannot collide', async () => {
    const { downloadClipToTempFile } = await import('@/lib/storage');
    const [first, second] = await Promise.all([
      downloadClipToTempFile('clips/a.mp4'),
      downloadClipToTempFile('clips/b.mp4'),
    ]);

    try {
      expect(first.path).not.toBe(second.path);
    } finally {
      await first.cleanUp();
      await second.cleanUp();
    }
  });
});
