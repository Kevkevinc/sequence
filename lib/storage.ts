import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getRequiredEnv } from '@/lib/env';

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${getRequiredEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: getRequiredEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: getRequiredEnv('R2_SECRET_ACCESS_KEY'),
  },
});

export async function createUploadUrl(originalFilename: string, contentType: string) {
  const storageKey = `clips/${randomUUID()}-${originalFilename}`;
  const command = new PutObjectCommand({
    Bucket: getRequiredEnv('R2_BUCKET_NAME'),
    Key: storageKey,
    ContentType: contentType,
  });
  const url = await getSignedUrl(client, command, { expiresIn: 300 });
  return { url, storageKey };
}

/** A clip on local disk, with the caller responsible for removing it. */
export type LocalClip = {
  /** Absolute path the Gemini SDK can upload straight from. */
  path: string;
  contentType: string;
  /** Removes the temp file. Safe to call twice; never throws. */
  cleanUp: () => Promise<void>;
};

/**
 * Streams a clip out of R2 and onto local disk, returning its path.
 *
 * Preferred over {@link getClipBuffer} for anything that touches whole videos.
 * Raw TikTok footage is routinely 100-200MB, and buffering it held the file
 * three times over — once in `Buffer.concat`, again in the `Uint8Array` copy,
 * and a third time inside the `Blob` handed to the SDK. A worker tagging
 * several clips at once could comfortably exceed a gigabyte resident and be
 * OOM-killed mid-job, which strands the job: nothing reaps a row left in
 * `tagging`. Streaming to disk keeps resident memory flat regardless of clip
 * size, and the SDK's `files.upload` accepts a path directly.
 */
export async function downloadClipToTempFile(storageKey: string): Promise<LocalClip> {
  const result = await client.send(
    new GetObjectCommand({
      Bucket: getRequiredEnv('R2_BUCKET_NAME'),
      Key: storageKey,
    })
  );

  const path = join(tmpdir(), `ugc-clip-${randomUUID()}`);
  let removed = false;
  try {
    await pipeline(result.Body as Readable, createWriteStream(path));
  } catch (error) {
    // The caller never receives a handle for a download that failed, so a
    // half-written file would be orphaned with nothing left to remove it.
    removed = true;
    await unlink(path).catch(() => {});
    throw error;
  }

  return {
    path,
    contentType: result.ContentType ?? 'application/octet-stream',
    cleanUp: async () => {
      if (removed) return;
      removed = true;
      // A leaked temp file is a far smaller problem than a failed job, so a
      // cleanup error is logged and swallowed rather than thrown.
      try {
        await unlink(path);
      } catch (error) {
        console.warn(`Could not remove temporary clip ${path}: ${String(error)}`);
      }
    },
  };
}

export async function getClipBuffer(storageKey: string): Promise<{ buffer: Buffer; contentType: string }> {
  const result = await client.send(
    new GetObjectCommand({
      Bucket: getRequiredEnv('R2_BUCKET_NAME'),
      Key: storageKey,
    })
  );

  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return {
    buffer: Buffer.concat(chunks),
    contentType: result.ContentType ?? 'application/octet-stream',
  };
}
