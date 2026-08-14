/**
 * Saving a finished video from the installed app.
 *
 * The videos live on R2, a different origin from the app. That single fact
 * shapes everything here:
 *
 *  - The HTML `download` attribute is ignored cross-origin, so a plain link to
 *    R2 cannot force a save — it just *navigates* there. Inside a standalone
 *    PWA a top-level navigation to another origin is bounced out to an in-app
 *    browser (the "Cloudflare page" a creator sees), where they then have to
 *    save by hand. That is the detour this module exists to avoid.
 *  - `window.open` per file is worse still: mobile browsers block every popup
 *    after the first, so "save them all" saved at most one.
 *
 * The native path on a phone is the OS share sheet: fetch the video's bytes,
 * wrap them in a `File`, and hand it to {@link navigator.share}. That surfaces
 * "Save Video" (to Photos) and every share target — TikTok included — without
 * ever leaving the app, and takes several files in a single action.
 *
 * Fetching the bytes cross-origin needs the bucket to allow it; see
 * `scripts/set-r2-cors.ts`. Where the share sheet is unavailable (desktop) or
 * anything fails, we fall back to a direct download from the presigned
 * attachment URL, which is exactly what the app did before — degraded, but
 * never silent.
 */

export type SaveableVideo = {
  /** Presigned URL the bytes are fetched from (the inline playback URL is fine). */
  url: string;
  /**
   * Presigned URL whose response is an attachment. Used for the desktop / no-
   * share fallback, where the browser downloads it directly.
   */
  downloadUrl?: string | null;
  /** Human name for the saved file, without extension. */
  name: string;
};

/** A filesystem-safe `.mp4` name; the share sheet and Files app show this. */
function fileNameFor(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'video'}.mp4`;
}

/**
 * Whether this browser can hand video files to the OS share sheet.
 *
 * Probed with an empty placeholder file so we test the capability *before*
 * fetching megabytes we might not be able to use — on a desktop browser with no
 * file sharing this returns false and we never download the video at all.
 */
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

async function fetchAsFile(video: SaveableVideo): Promise<File> {
  const res = await fetch(video.url);
  if (!res.ok) throw new Error(`Could not fetch the video (${res.status})`);
  const blob = await res.blob();
  return new File([blob], fileNameFor(video.name), { type: blob.type || 'video/mp4' });
}

/** The cross-origin-safe direct download the app used before the share sheet. */
function anchorDownload(video: SaveableVideo): void {
  const anchor = document.createElement('a');
  anchor.href = video.downloadUrl ?? video.url;
  anchor.rel = 'noopener';
  // Honoured same-origin; cross-origin the presigned attachment disposition
  // carries the filename instead. Harmless either way.
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
 * Saves one video: share sheet where possible, direct download otherwise.
 *
 * Resolves once the sheet is shown (or the download begins); it does not wait
 * for the creator to pick a target.
 */
export async function saveVideo(video: SaveableVideo): Promise<void> {
  if (canShareVideos(1)) {
    try {
      const file = await fetchAsFile(video);
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (err) {
      if (isShareCancel(err)) return;
      // Any other failure (offline, expired URL, bucket not yet CORS-enabled)
      // drops through to the download below rather than leaving a dead button.
    }
  }
  anchorDownload(video);
}

/**
 * Saves several videos in one action.
 *
 * The share sheet takes them all at once — one "Save N Videos" on a phone.
 * Without it, each falls back to its own direct download.
 */
export async function saveVideos(videos: SaveableVideo[]): Promise<void> {
  if (videos.length === 0) return;
  if (videos.length === 1) return saveVideo(videos[0]);

  if (canShareVideos(videos.length)) {
    try {
      const files = await Promise.all(videos.map(fetchAsFile));
      if (navigator.canShare({ files })) {
        await navigator.share({ files });
        return;
      }
    } catch (err) {
      if (isShareCancel(err)) return;
      // Fall through to per-file downloads.
    }
  }
  for (const video of videos) anchorDownload(video);
}
