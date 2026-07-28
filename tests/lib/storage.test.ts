import { describe, it, expect, vi, beforeEach } from 'vitest';
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
