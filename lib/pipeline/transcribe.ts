import { stat, unlink } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { FileState } from '@google/genai';
import { getGeminiClient } from '@/lib/gemini/client';
import { getEnvWithDefault } from '@/lib/env';
import { runFfmpeg } from '@/lib/render/ffmpeg';
import { describeCause } from '@/lib/pipeline/errors';
import { withTransientRetry, type TransientRetryOptions } from '@/lib/pipeline/retry';
import { recordUsage } from '@/lib/pipeline/usage';

const TRANSCRIBE_MODEL = getEnvWithDefault('GEMINI_TRANSCRIBE_MODEL', 'gemini-3.6-flash');

const TRANSCRIBE_RETRY: TransientRetryOptions = {
  attempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 16000,
  label: 'Gemini transcription call',
};

const FILE_POLL_ATTEMPTS = 30;
const FILE_POLL_INTERVAL_MS = 2000;

/**
 * Asks for plain text, and only for the words — never for timings.
 *
 * The model's timestamps were measured against a synthesised track with known
 * word positions and drift to -0.7s within ten seconds (see `speech.ts`). Not
 * asking for them keeps a number that cannot be trusted out of the pipeline
 * entirely, and makes the response several times smaller, which is most of what
 * a transcription call costs.
 *
 * Filler words are kept deliberately: the editor decides what to cut, and it
 * cannot cut an "um" the transcript quietly tidied away.
 */
/** What the model replies with when there is nothing to transcribe. */
const NO_SPEECH_SENTINEL = 'NO_SPEECH';

const TRANSCRIBE_PROMPT = `Transcribe the speech in this audio, word for word.

Reply with the transcript as plain text and nothing else — no JSON, no labels, no timestamps,
no speaker names, no commentary.
Include filler words like "um", "uh", "like" and false starts exactly as spoken. Do NOT clean up,
summarise, paraphrase or punctuate for style.
If nobody is speaking (music, room noise or silence only), reply with exactly: ${NO_SPEECH_SENTINEL}`;

export type Transcript = {
  /** Words in spoken order. Timing is added later from the measured audio. */
  words: string[];
  text: string;
};

export type TranscribeResult =
  | { success: true; transcript: Transcript }
  | { success: false; error: string };

/** Uncompressed 16kHz mono: see {@link extractAudio}. */
const AUDIO_MIME_TYPE = 'audio/wav';

/**
 * Extracts a small mono audio file for transcription.
 *
 * Video is never uploaded for this: Gemini bills audio at roughly a tenth of
 * video per second, transcription cannot use the pixels, and a raw 4K clip is
 * a couple of hundred megabytes to push over the wire. 16kHz mono is the rate
 * speech recognition wants anyway.
 *
 * WAV rather than the AAC-in-M4A this originally produced. That version
 * transcribed reliably when run on Windows and failed every single time on the
 * Linux worker — same source file, same code, fifteen consecutive 500s from the
 * model against none locally. The one thing that genuinely differed between the
 * two was the ffmpeg build writing the container. WAV has no container
 * subtleties to differ over: it is a header and raw samples, it is on the
 * model's supported list, and at 16kHz mono a thirty-second take is about a
 * megabyte — small enough that the compression was never buying much.
 */
async function extractAudio(sourcePath: string): Promise<string> {
  const outputPath = path.join(tmpdir(), `ugc-speech-${randomUUID()}.wav`);
  const result = await runFfmpeg([
    '-i', sourcePath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    outputPath,
  ]);
  if (!result.success) {
    throw new Error(`Could not extract audio for transcription: ${result.error}`);
  }
  return outputPath;
}

/** Splits a transcript into the word sequence the aligner works on. */
export function wordsOf(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);
}

/**
 * Transcribes what is said in a clip.
 *
 * Returns the words only. Where they fall in time is established separately by
 * measuring the audio, and joined to these by the aligner.
 */
export async function transcribeClip(sourcePath: string): Promise<TranscribeResult> {
  let audioPath: string | undefined;

  try {
    audioPath = await extractAudio(sourcePath);
    const client = getGeminiClient();
    const localAudio = audioPath;

    /*
     * Described in every failure below.
     *
     * This step failed on the deployed worker while succeeding locally on the
     * same recording, and the error said only "the call failed" — which cannot
     * distinguish a bad file from a bad upload from a model outage, and left
     * the difference between the two machines invisible. The audio's own
     * measurements are the thing that differed, so they travel with the error.
     */
    const { size } = await stat(localAudio);
    const describeAudio = () =>
      `${AUDIO_MIME_TYPE}, ${(size / 1024).toFixed(0)}KB, from ${path.basename(sourcePath)}`;

    const response = await withTransientRetry(async () => {
      const uploaded = await client.files.upload({
        file: localAudio,
        config: { mimeType: AUDIO_MIME_TYPE },
      }).catch((error) => {
        throw new Error(`upload of the audio failed (${describeAudio()}): ${describeCause(error)}`);
      });
      if (!uploaded.name || !uploaded.uri) {
        throw new Error('Gemini upload did not return a usable file reference');
      }
      if (uploaded.state !== FileState.ACTIVE) {
        for (let attempt = 0; attempt < FILE_POLL_ATTEMPTS; attempt++) {
          const file = await client.files.get({ name: uploaded.name });
          if (file.state === FileState.ACTIVE) break;
          if (file.state === FileState.FAILED) throw new Error('Gemini file processing failed');
          await new Promise((resolve) => setTimeout(resolve, FILE_POLL_INTERVAL_MS));
        }
      }

      return client.models.generateContent({
        model: TRANSCRIBE_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { fileUri: uploaded.uri, mimeType: AUDIO_MIME_TYPE } },
              { text: TRANSCRIBE_PROMPT },
            ],
          },
        ],
      });
    }, TRANSCRIBE_RETRY).catch((error) => {
      throw new Error(`${describeCause(error)} [audio: ${describeAudio()}]`);
    });

    // Metered before the response is inspected: the call was billed whether or
    // not the answer turns out to be usable.
    await recordUsage({
      kind: 'tagging',
      model: TRANSCRIBE_MODEL,
      usage: response.usageMetadata,
    });

    const text = (response.text ?? '').trim();

    // The sentinel is matched loosely: the model occasionally wraps it in a
    // sentence, and "NO_SPEECH." should not be transcribed as a word.
    if (!text || text.toUpperCase().includes(NO_SPEECH_SENTINEL)) {
      return {
        success: false,
        error:
          'No speech was found in this recording. Talking mode needs a clip of you speaking to camera.',
      };
    }

    return { success: true, transcript: { text, words: wordsOf(text) } };
  } catch (error) {
    return { success: false, error: `Could not transcribe the recording: ${describeCause(error)}` };
  } finally {
    // A leaked temp file is smaller than a failed job, so cleanup never throws.
    if (audioPath) await unlink(audioPath).catch(() => {});
  }
}
