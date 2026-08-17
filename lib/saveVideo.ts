/**
 * Saving a finished video from the installed app.
 *
 * The videos live on R2, a different origin from the app, which shapes
 * everything here. Two ways to get a video onto the phone:
 *
 *  - **Share sheet** (`navigator.share({ files })`): the nice one — "Save Video"
 *    straight to Photos, or share to TikTok, without leaving the app. But it
 *    needs the whole video *in memory* first, and iOS refuses files past a few
 *    hundred MB. A 4K video is ~25MB/s (a 30s clip ≈ 800MB), so the share sheet
 *    both takes forever to load and then silently rejects it. So this path is
 *    only used for videos small enough to actually go through it (1080p).
 *  - **Blob download** (save the fetched bytes via a `blob:` URL): used when the
 *    share sheet is unavailable or refuses the file. A `blob:` URL is
 *    *same-origin*, so the browser saves it to Files rather than doing what a
 *    link to R2 does inside a standalone PWA — bounce out to an in-app browser
 *    (the "Cloudflare page"). The plain R2 link is only used on desktop, where
 *    there is no PWA to bounce out of.
 *
 * Both mobile paths fetch the bytes first (with progress), so neither leaves the
 * app. Fetching cross-origin needs the bucket to allow it; see
 * `scripts/set-r2-cors.ts`.
 */

export type SaveableVideo = {
  /** Presigned URL the bytes are fetched from (the inline playback URL is fine). */
  url: string;
  /**
   * Presigned URL whose response is an attachment. The direct-download path
   * points the browser at this so it saves rather than plays.
   */
  downloadUrl?: string | null;
  /** Human name for the saved file, without extension. */
  name: string;
};

/** Reports 0..1 download progress, for a button that would otherwise look dead. */
export type ProgressFn = (fraction: number) => void;

/** A filesystem-safe `.mp4` name; the share sheet and Files app show this. */
function fileNameFor(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'video'}.mp4`;
}

/** Whether this browser can hand video files to the OS share sheet at all. */
function canShareVideos(count: number): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') {
    return false;
  }
  const probe = Array.from(
    { length: count },
    (_, i) => new File([new Uint8Array()], `probe-${i}.mp4`, { type: 'video/mp4' })
  );
  try {
    return navigator.canShare({ files: probe });
  } catch {
    return false;
  }
}

/**
 * Reads a response body into a File, reporting progress as it goes.
 *
 * Streamed rather than `res.blob()` so the button can show real progress on a
 * large file instead of a spinner that looks stuck.
 */
async function readToFile(res: Response, name: string, onProgress?: ProgressFn): Promise<File> {
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming reader (very old browser): fall back to a plain blob.
    return new File([await res.blob()], fileNameFor(name), { type: 'video/mp4' });
  }
  const chunks: BlobPart[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (total > 0) onProgress?.(loaded / total);
  }
  return new File(chunks, fileNameFor(name), { type: 'video/mp4' });
}

/**
 * Saves already-fetched bytes via a same-origin `blob:` URL.
 *
 * The download comes from the app's own origin, so a standalone PWA saves it to
 * Files instead of bouncing out to the R2 page. Used when the share sheet is
 * unavailable or refuses the file.
 */
function blobDownload(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked late so the download has certainly started reading it first.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * The desktop / no-share fallback: a plain link to the presigned attachment URL.
 *
 * Only reached where the share sheet does not exist (desktop browsers), which is
 * also where a cross-origin link downloads cleanly with no PWA to bounce out of.
 */
function linkDownload(video: SaveableVideo): void {
  const anchor = document.createElement('a');
  anchor.href = video.downloadUrl ?? video.url;
  anchor.rel = 'noopener';
  anchor.download = fileNameFor(video.name);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** A share sheet dismissed by the creator is a completed action, not an error. */
function isShareCancel(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * Saves one video.
 *
 * On a phone: fetch the bytes (reporting progress), then offer the OS share
 * sheet — "Save Video" to Photos, or Save to Files — which is the iOS-native way
 * to save. If the share sheet is unavailable or refuses the file, save the same
 * bytes via a `blob:` URL, which lands in Files without ever leaving the app.
 * The plain R2 link is used only where there is no share sheet at all (desktop).
 *
 * `onProgress` reports the fetch (0..1). Resolves once the share sheet is shown
 * or the download has started.
 */
export async function saveVideo(video: SaveableVideo, onProgress?: ProgressFn): Promise<void> {
  if (!canShareVideos(1)) {
    linkDownload(video);
    return;
  }

  let file: File;
  try {
    const res = await fetch(video.url);
    if (!res.ok) throw new Error(`Could not fetch the video (${res.status})`);
    file = await readToFile(res, video.name, onProgress);
  } catch {
    // Never got the bytes (offline, expired URL) — last resort is the plain link.
    linkDownload(video);
    return;
  }

  if (navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (isShareCancel(err)) return;
      // Share refused the file — fall through to saving the bytes we hold.
    }
  }
  blobDownload(file);
}

/**
 * Saves several videos at once.
 *
 * The share sheet takes them together where it can — one "Save N Videos".
 * Otherwise each is fetched and saved via its own `blob:` URL, still without
 * leaving the app.
 */
export async function saveVideos(videos: SaveableVideo[]): Promise<void> {
  if (videos.length === 0) return;
  if (videos.length === 1) return saveVideo(videos[0]);

  if (!canShareVideos(videos.length)) {
    for (const video of videos) linkDownload(video);
    return;
  }

  let files: File[];
  try {
    files = [];
    for (const video of videos) {
      const res = await fetch(video.url);
      if (!res.ok) throw new Error(`Could not fetch the video (${res.status})`);
      files.push(await readToFile(res, video.name));
    }
  } catch {
    for (const video of videos) linkDownload(video);
    return;
  }

  if (navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      return;
    } catch (err) {
      if (isShareCancel(err)) return;
      // Fall through to per-file blob downloads.
    }
  }
  for (const file of files) blobDownload(file);
}
