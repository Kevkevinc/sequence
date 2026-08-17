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
 *  - **Direct download** (a link to the presigned attachment URL): the browser
 *    streams it to Files with its own progress UI — no in-memory copy, any size.
 *    Used for large videos and as the fallback whenever the share sheet is
 *    unavailable or fails. Lands in Files rather than Photos, which for a
 *    several-hundred-MB 4K master is the only place iOS will put it anyway.
 *
 * Fetching the bytes cross-origin needs the bucket to allow it; see
 * `scripts/set-r2-cors.ts`.
 */

/**
 * Largest video handed to the OS share sheet. Above this iOS tends to reject
 * the file (and buffering it in memory is slow and can crash the tab), so a
 * bigger video goes straight to a direct download instead. 1080p exports sit
 * well under this; 4K exports sit well over it.
 */
const SHARE_MAX_BYTES = 150 * 1024 * 1024;

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

/** The cross-origin-safe direct download: the browser streams it to Files itself. */
function directDownload(video: SaveableVideo): void {
  const anchor = document.createElement('a');
  anchor.href = video.downloadUrl ?? video.url;
  anchor.rel = 'noopener';
  // Honoured same-origin; cross-origin the presigned attachment disposition
  // carries the filename and forces the save instead.
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
 * Saves one video: share sheet for small ones, direct download otherwise.
 *
 * `onProgress` reports the fetch of a shareable video (0..1). A direct download
 * has no in-app progress — the browser shows its own — so it is not reported.
 * Resolves once the share sheet is shown or the download has started.
 */
export async function saveVideo(video: SaveableVideo, onProgress?: ProgressFn): Promise<void> {
  if (canShareVideos(1)) {
    const controller = new AbortController();
    try {
      const res = await fetch(video.url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Could not fetch the video (${res.status})`);

      const total = Number(res.headers.get('content-length')) || 0;
      if (total > 0 && total <= SHARE_MAX_BYTES) {
        const file = await readToFile(res, video.name, onProgress);
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          return;
        }
      } else {
        // Too big for the share sheet (or unknown size): don't spend minutes
        // buffering a file iOS will reject — stop the fetch and download direct.
        controller.abort();
      }
    } catch (err) {
      if (isShareCancel(err)) return;
      // Anything else (offline, expired URL, share refused) drops to a download.
    }
  }
  directDownload(video);
}

/**
 * Saves several videos at once.
 *
 * When they are all small enough, the share sheet takes them together — one
 * "Save N Videos". Otherwise each is downloaded directly, which is also what
 * happens for 4K, where the files are far too big to share.
 */
export async function saveVideos(videos: SaveableVideo[]): Promise<void> {
  if (videos.length === 0) return;
  if (videos.length === 1) return saveVideo(videos[0]);

  if (canShareVideos(videos.length)) {
    try {
      const files: File[] = [];
      for (const video of videos) {
        const res = await fetch(video.url);
        if (!res.ok) throw new Error(`Could not fetch the video (${res.status})`);
        const total = Number(res.headers.get('content-length')) || 0;
        // If any one is too big to share, sharing the batch will fail too —
        // bail out to per-file downloads rather than buffer them all.
        if (total === 0 || total > SHARE_MAX_BYTES) throw new Error('too large to share');
        files.push(await readToFile(res, video.name));
      }
      if (navigator.canShare({ files })) {
        await navigator.share({ files });
        return;
      }
    } catch (err) {
      if (isShareCancel(err)) return;
      // Fall through to per-file downloads.
    }
  }
  for (const video of videos) directDownload(video);
}
