import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { removeBackground } from '@imgly/background-removal-node';
import { HEIGHT, WIDTH } from '@/lib/render/frame';

/**
 * The Fit Inspo intro: reference images stacking up over the opening footage
 * while the hook is on screen, then all clearing at once so the edit proper can
 * start.
 *
 * Modelled on the reference videos the creator supplied. Three details there
 * turn out to carry the whole look:
 *
 *  - The footage keeps playing underneath. These float over the opening shot;
 *    they are not a slideshow the video cuts away to.
 *  - They accumulate rather than replace, so by the end of the intro several
 *    are on screen at once.
 *  - They sit down one side, staggered and overlapping, leaving the other side
 *    clear for the creator — who is generally framed to one side of shot.
 */
export const FIT_INSPO = {
  /** Hook is alone on screen before this, which is what makes the first one land. */
  firstAppearsAtSeconds: 1.5,
  /** Gap between each appearing. Short: they should read as a burst. */
  staggerSeconds: 0.35,
  /** They all clear together here, and the hook goes with them. */
  clearsAtSeconds: 4,
  /**
   * Fraction of frame height each image occupies, by how many there are.
   *
   * Fewer images should fill the space rather than leave the frame looking
   * empty: one on its own reads as a deliberate reference shot at half the
   * height, where three at that size would be a pile.
   */
  heightRatioFor: { 1: 0.52, 2: 0.42, 3: 0.34, 4: 0.3 } as Record<number, number>,
  /**
   * Ceiling on width, as a fraction of the frame.
   *
   * Sizing by height alone blows a landscape image -- a wide product listing,
   * say -- across most of the frame and off the edge. Whichever constraint
   * binds first wins.
   */
  maxWidthRatio: 0.46,
  /** Keeps a stack member from touching the frame edge. */
  marginRatio: 0.03,
  /** More than this on screen is mush; extras are ignored. */
  maxImages: 4,
  /**
   * When the sizing block may start.
   *
   * It has to wait for the intro to clear: appearing at the usual post-hook
   * moment puts it under the stack while the stack is still up.
   */
  sizingStartsAtSeconds: 4,
};

export type FitInspoSource = {
  /** Local path to the uploaded image. */
  path: string;
  /**
   * `person` gets its background removed; `listing` is composited untouched.
   *
   * Only `person` is reachable today — per creator direction the intro is
   * model shots only for now. The branch stays because the reference videos
   * mix in product-listing screenshots and that is a likely near-term return,
   * and because the column already records it.
   */
  kind: 'person' | 'listing';
};

/** One image, cut out if needed, with where and when it belongs on screen. */
export type FitInspoLayer = {
  file: string;
  from: number;
  to: number;
  /** Top-left corner in frame pixels, ready for ffmpeg's overlay filter. */
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Where the n-th image sits.
 *
 * Down the left, top to bottom, with each one nudged horizontally so the column
 * reads as a hand-placed stack rather than a list. Ratios rather than pixels so
 * this survives a change of output resolution.
 */
function placementFor(index: number, count: number, width: number, height: number) {
  const laneCentreX = [0.28, 0.34, 0.24, 0.32][index % 4];
  // Spread the stack down the upper two-thirds: below that it collides with the
  // sizing overlay, which lives in a bottom quadrant.
  const topRatio = 0.16;
  const bottomRatio = 0.62;
  const step = count > 1 ? (bottomRatio - topRatio) / (count - 1) : 0;
  const centreY = topRatio + step * index;

  // Clamped rather than trusted: the lane centres assume a portrait-ish image,
  // and a wide one placed on centre alone hangs off the side of the frame.
  const margin = Math.round(WIDTH * FIT_INSPO.marginRatio);
  const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, max - margin));

  return {
    x: clamp(Math.round(WIDTH * laneCentreX - width / 2), WIDTH - width),
    y: clamp(Math.round(HEIGHT * centreY - height / 2), HEIGHT - height),
  };
}

/**
 * Prepares the intro images for one render.
 *
 * Background removal is the slow part (~3s an image) and runs here rather than
 * at upload so a re-render never depends on a file some earlier step happened
 * to leave behind. `person` images that fail to cut out fall back to the
 * original rather than dropping out of the video: a rectangular fit pic is a
 * worse look than a cutout, but no worse than a missing one.
 */
export async function prepareFitInspoLayers(
  sources: FitInspoSource[],
  workingDir: string
): Promise<FitInspoLayer[]> {
  const used = sources.slice(0, FIT_INSPO.maxImages);
  const layers: FitInspoLayer[] = [];

  for (const [index, source] of used.entries()) {
    let file = source.path;

    if (source.kind === 'person') {
      try {
        // A file:// URL, not a bare path: on Windows the library reads "C:" as
        // an unsupported protocol.
        const cutout = await removeBackground(pathToFileURL(source.path).href);
        file = path.join(workingDir, `fit-inspo-${index}.png`);
        await writeFile(file, Buffer.from(await cutout.arrayBuffer()));
      } catch (error) {
        console.warn(
          `Fit Inspo: could not cut out ${path.basename(source.path)}, using it as-is: ` +
            `${error instanceof Error ? error.message : error}`
        );
        file = source.path;
      }
    }

    const { width, height } = await scaledSize(file, used.length);
    const { x, y } = placementFor(index, used.length, width, height);

    layers.push({
      file,
      from: FIT_INSPO.firstAppearsAtSeconds + index * FIT_INSPO.staggerSeconds,
      to: FIT_INSPO.clearsAtSeconds,
      x,
      y,
      width,
      height,
    });
  }

  return layers;
}

/**
 * Size an image to {@link FIT_INSPO.heightRatio} of the frame, keeping aspect.
 *
 * Measured from the file rather than assumed: a cutout's aspect ratio is not
 * the upload's, since removing the background does not crop to the subject.
 */
async function scaledSize(
  file: string,
  count: number
): Promise<{ width: number; height: number }> {
  const { loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(await readFile(file));
  const aspect = image.width / image.height;
  const ratio = FIT_INSPO.heightRatioFor[count] ?? FIT_INSPO.heightRatioFor[4];
  let height = Math.round(HEIGHT * ratio);
  let width = Math.round(aspect * height);

  const maxWidth = Math.round(WIDTH * FIT_INSPO.maxWidthRatio);
  if (width > maxWidth) {
    width = maxWidth;
    height = Math.round(maxWidth / aspect);
  }

  return { width, height };
}
