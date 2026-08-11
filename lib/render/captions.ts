import { HEIGHT, WIDTH, scaled as scaleToFrame } from '@/lib/render/frame';
import { captionFont } from '@/lib/render/fonts';
import type { CaptionSettings } from '@/lib/render/captionSettings';
import type { CaptionCue } from '@/lib/pipeline/align';

/**
 * Builds an ASS subtitle track for spoken captions.
 *
 * ASS rather than the PNG-per-layer approach the hook uses. A talking video
 * produces a caption every second or so, which is 30-60 overlay inputs on a
 * single ffmpeg command — each one a full-frame RGBA image decoded and
 * composited for the whole video. libass draws text directly and is built into
 * the bundled ffmpeg (`--enable-libass`), so the same job becomes one filter
 * and one small text file.
 *
 * The hook keeps its PNG path: there is exactly one of it, and it already
 * shares layout code with the preview.
 */

/** ASS colours are `&HAABBGGRR` — alpha first, then *reversed* RGB. */
function assColour(hex: string, alphaHex = '00'): string {
  const clean = hex.replace('#', '');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${alphaHex}${b}${g}${r}`.toUpperCase();
}

/** `0:00:01.23` — ASS wants centiseconds, and exactly one leading hour digit. */
export function assTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const centis = Math.round((safe - Math.floor(safe)) * 100);
  // Rounding can carry to the next second; normalise rather than emit ".100".
  const carried = centis === 100;
  return (
    `${hours}:${String(minutes).padStart(2, '0')}:` +
    `${String(carried ? secs + 1 : secs).padStart(2, '0')}.` +
    `${String(carried ? 0 : centis).padStart(2, '0')}`
  );
}

/**
 * Makes caption text safe to put in a Dialogue line.
 *
 * Braces open an override block in ASS, so a caption containing one would be
 * silently swallowed or corrupt the styling; a literal newline would end the
 * event early and drop everything after it.
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, '\\N');
}

/**
 * Renders cues as a complete `.ass` file.
 *
 * Positioned with an explicit `\pos` per event rather than a style margin, so
 * captions honour the same fractional coordinates as every other overlay in
 * this project and land where the preview put them. Alignment 5 makes `\pos`
 * address the middle of the text rather than a corner, which is what a
 * centre-based coordinate means.
 */
export function buildAssFile(
  cues: CaptionCue[],
  settings: CaptionSettings,
  options: { position?: { x: number; y: number } } = {}
): string {
  const font = captionFont(settings.fontId);
  const fontSize = scaleToFrame(settings.sizingFontSize);
  const x = Math.round((options.position?.x ?? 0.5) * WIDTH);
  const y = Math.round((options.position?.y ?? 0.78) * HEIGHT);

  // Matches the burned-in hook: white fill over a dark outline, no drop shadow.
  // The outline is what keeps a caption readable over arbitrary footage.
  const outline = Math.max(1, Math.round(fontSize * 0.12));

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${WIDTH}`,
    `PlayResY: ${HEIGHT}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,' +
      ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,' +
      ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Spoken,${font.familyName},${fontSize},${assColour(settings.textColor)},` +
      `${assColour(settings.textColor)},${assColour('#000000')},${assColour('#000000', '80')},` +
      `0,0,0,0,100,100,0,0,1,${outline},0,5,40,40,40,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = cues
    // A zero-length cue is never drawn by libass and only adds noise to the file.
    .filter((cue) => cue.endSeconds > cue.startSeconds)
    .map(
      (cue) =>
        `Dialogue: 0,${assTime(cue.startSeconds)},${assTime(cue.endSeconds)},Spoken,,0,0,0,,` +
        `{\\pos(${x},${y})}${escapeAssText(cue.text)}`
    );

  return [...header, ...events, ''].join('\n');
}

/**
 * Makes a filesystem path safe to embed in an ffmpeg filter argument.
 *
 * Filter options are separated by `:` and filters by `,`, so a Windows path
 * like `C:/x` ends the option early — ffmpeg then reports something misleading
 * such as "Error applying option 'original_size'". Backslashes are normalised
 * to forward slashes first (ffmpeg accepts those on Windows and they avoid a
 * second layer of escaping), then the colon is escaped exactly once. Escaping
 * it twice reads as an escaped backslash followed by a live colon, which fails
 * the same way.
 */
export function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:');
}
