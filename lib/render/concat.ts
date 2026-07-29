import { rm, stat, writeFile } from 'fs/promises';
import { runFfmpeg } from '@/lib/render/ffmpeg';

/**
 * Renders one line of a concat-demuxer list file.
 *
 * The format quotes each path with single quotes, and its only escape is to
 * close the quote, emit an escaped quote, and reopen — `'\''`. A creator's
 * folder can easily be `Kev's clips`, and without this the list silently ends
 * the path early and ffmpeg reports a file nobody asked for.
 *
 * Backslashes are replaced with forward slashes rather than escaped: ffmpeg
 * accepts `C:/Users/...` on Windows, and the demuxer treats a backslash inside
 * a quoted path as an escape character, so a Windows path would otherwise lose
 * its separators.
 */
function listLine(filePath: string): string {
  const forwardSlashed = filePath.replace(/\\/g, '/');
  return `file '${forwardSlashed.replace(/'/g, "'\\''")}'`;
}

/**
 * Removes a half-written output.
 *
 * ffmpeg opens the output before it reads the first input, so a rejected input
 * leaves a 0-byte file behind. Callers treat "failed" as "nothing was written".
 */
async function discardOutput(outputPath: string): Promise<void> {
  await rm(outputPath, { force: true }).catch(() => {});
}

/**
 * Joins normalised cuts, in order, into a single video.
 *
 * Uses the concat *demuxer* with `-c copy` rather than the concat filter: every
 * part comes from `normaliseCut`, so they already share codec, resolution,
 * frame rate and audio parameters, and a stream copy is both faster and
 * lossless. That precondition is the whole reason this is a copy — handing it
 * parts of differing formats will fail, or produce a broken file, rather than
 * silently re-encoding.
 *
 * Never throws; a failure is an outcome the caller records against the job.
 */
export async function concatCuts(
  paths: string[],
  outputPath: string
): Promise<{ success: true } | { success: false; error: string }> {
  if (paths.length === 0) {
    return { success: false, error: 'Cannot concatenate: no cuts were given' };
  }

  // Check the parts up front. The demuxer's own complaint about a missing file
  // arrives buried in decoder output, and by then it has already created the
  // output file we would have to clean up.
  for (const part of paths) {
    try {
      const info = await stat(part);
      if (!info.isFile()) return { success: false, error: `Cut is not a file: ${part}` };
    } catch {
      return { success: false, error: `Cut is missing: ${part}` };
    }
  }

  // Kept beside the output, so the caller's per-render temp directory holds
  // everything this produced and a crash cannot strand it somewhere else.
  const listPath = `${outputPath}.concat.txt`;
  try {
    await writeFile(listPath, `${paths.map(listLine).join('\n')}\n`, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Could not write the concat list: ${detail}` };
  }

  try {
    // `-safe 0` allows absolute paths in the list, which is what we write.
    const result = await runFfmpeg([
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      outputPath,
    ]);
    if (!result.success) await discardOutput(outputPath);
    return result;
  } finally {
    await rm(listPath, { force: true }).catch(() => {});
  }
}
