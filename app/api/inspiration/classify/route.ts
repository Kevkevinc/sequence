import { auth } from '@clerk/nextjs/server';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { classifyInspirationImage } from '@/lib/images/classify';

/**
 * Guesses whether an uploaded image is a person or a product listing.
 *
 * Server-side because the classifier reads raw pixels through a canvas, and
 * because the same answer is wanted by any future non-browser client.
 *
 * The answer is a suggestion. The upload screen shows it for confirmation
 * rather than acting on it silently: the heuristic will occasionally be wrong,
 * and a listing screenshot with its background cut away loses the price and the
 * card, which is the whole reason it was uploaded.
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return Response.json(
      { error: 'Send an image as multipart form field "file".' },
      { status: 400 }
    );
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'ugc-classify-'));
  try {
    const local = path.join(dir, 'upload');
    await writeFile(local, Buffer.from(await file.arrayBuffer()));
    return Response.json(await classifyInspirationImage(local));
  } catch (error) {
    // An unreadable image is not worth failing an upload over. Fall back to
    // `person` with zero confidence, which the screen surfaces as needing a
    // look rather than as a decision it made.
    return Response.json({
      kind: 'person',
      confidence: 0,
      reason: `Could not read this image (${error instanceof Error ? error.message : error}).`,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
