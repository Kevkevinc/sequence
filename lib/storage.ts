import { randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { stat, unlink } from 'fs/promises';
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
  /*
   * Without these the SDK waits forever. A clip download is ~100MB streamed
   * from R2, and if that connection half-drops mid-stream nothing breaks the
   * wait -- a deployed render sat in `rendering` for 75 minutes on exactly
   * this, with ffmpeg never even starting.
   *
   * socketTimeout is per-chunk idle time, not total transfer time, so a big
   * clip on a slow link is fine; only a genuinely stalled socket trips it.
   * Retries then give a dropped connection a second chance instead of failing
   * the whole variation.
   */
  requestHandler: { connectionTimeout: 10_000, socketTimeout: 120_000 },
  maxAttempts: 3,
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

/**
 * A short-lived, signed link a browser can play or download a rendered video
 * from directly. The bucket itself stays private; nothing is ever public.
 *
 * Defaults to an hour — long enough for a video-detail page to sit open and
 * scrub through several variations without the link expiring mid-session,
 * short enough that a leaked or logged URL is worthless soon after.
 */
/**
 * Reduces a product name to something safe for a Content-Disposition header:
 * ASCII only, no quotes, no path separators. Anything else risks a malformed
 * header or a filename the OS refuses to write.
 */
function safeFilename(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return base || 'video';
}

/**
 * Presigns a GET for an object.
 *
 * `downloadAs` makes the response an attachment rather than something the
 * browser plays inline. It has to come from the URL itself: the page's
 * download links point at R2, which is a different origin, and the HTML
 * `download` attribute is *ignored cross-origin* — so without this the browser
 * simply navigates to the video. On a phone that means it opens in a player
 * with no way to save it, which is why downloads only ever worked on desktop.
 *
 * Left off for playback and thumbnails, which must stay inline for `<video>`
 * and `<img>` to render them.
 */
export async function createDownloadUrl(
  storageKey: string,
  options: { expiresIn?: number; downloadAs?: string } = {}
): Promise<string> {
  const { expiresIn = 3600, downloadAs } = options;
  const command = new GetObjectCommand({
    Bucket: getRequiredEnv('R2_BUCKET_NAME'),
    Key: storageKey,
    ...(downloadAs
      ? { ResponseContentDisposition: `attachment; filename="${safeFilename(downloadAs)}.mp4"` }
      : {}),
  });
  return getSignedUrl(client, command, { expiresIn });
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

/**
 * Streams a finished render onto R2 under `renders/`, alongside the source
 * clips under `clips/`.
 *
 * Streamed from disk with an explicit Content-Length rather than buffered into
 * memory: a rendered video is smaller than raw phone footage but still tens of
 * megabytes, and {@link downloadClipToTempFile}'s doc comment already explains
 * why this codebase treats "buffer a whole video in RAM" as a real risk.
 */
export async function uploadRenderedVideo(
  localPath: string,
  storageKey: string
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const { size } = await stat(localPath);
    await client.send(
      new PutObjectCommand({
        Bucket: getRequiredEnv('R2_BUCKET_NAME'),
        Key: storageKey,
        Body: createReadStream(localPath),
        ContentLength: size,
        ContentType: 'video/mp4',
      })
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Uploads a still frame for a render.
 *
 * Stored at a key *derived* from the video's own (`<key>.jpg`) rather than
 * recorded in a column of its own: the renders table already knows the video
 * key, so a derived key needs no migration and no extra state to keep in sync,
 * and a render made before thumbnails existed simply has no object at that key
 * — which the UI already treats as "fall back to the placeholder".
 */
export function thumbnailKeyFor(storageKey: string): string {
  return `${storageKey}.jpg`;
}

export async function uploadRenderThumbnail(
  localPath: string,
  storageKey: string
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const { size } = await stat(localPath);
    await client.send(
      new PutObjectCommand({
        Bucket: getRequiredEnv('R2_BUCKET_NAME'),
        Key: thumbnailKeyFor(storageKey),
        Body: createReadStream(localPath),
        ContentLength: size,
        ContentType: 'image/jpeg',
      })
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
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
