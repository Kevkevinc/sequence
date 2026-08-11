import { readFile } from 'fs/promises';
import path from 'path';
import { CAPTION_FONTS } from '@/lib/render/fonts';

/**
 * Serves a caption font to the preview.
 *
 * The preview must load the *same file* the renderer draws with, or it stops
 * being a preview: a browser falling back to its own sans would show line
 * breaks and a block height the video will not reproduce. Served from
 * `assets/fonts` rather than copied into `public/` so there is exactly one
 * copy of each binary in the repo and no way for the two to drift.
 *
 * Only ids in {@link CAPTION_FONTS} resolve. The id is never joined into a
 * path — it selects a known entry whose filename is a constant — so a
 * traversal attempt reads as an unknown font and 404s.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fontId: string }> }
) {
  const { fontId } = await params;
  const font = CAPTION_FONTS.find((f) => f.id === fontId);
  if (!font) return new Response('Unknown font', { status: 404 });

  try {
    const file = await readFile(path.join(process.cwd(), 'assets', 'fonts', font.file));
    return new Response(new Uint8Array(file), {
      headers: {
        'Content-Type': 'font/ttf',
        // The set is fixed and the files never change once committed, so this
        // is safe to cache hard — the preview should not re-fetch a 170KB
        // typeface every time a creator opens the screen.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('Font file missing', { status: 500 });
  }
}
