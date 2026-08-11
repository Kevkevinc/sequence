import { unlink } from 'fs/promises';
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
 * Asks only for the words, in order — never for timings.
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
const TRANSCRIBE_PROMPT = `Transcribe the speech in this audio, word for word.

Return JSON only: {"speech": boolean, "text": string}
- "speech" is false if nobody is speaking (music, room noise, or silence only).
- "text" is the full transcript as plain text.
- Transcribe exactly what is said, including filler words like "um", "uh", "like"
  and false starts. Do NOT clean up, summarise, paraphrase or punctuate for style.
- Do not include timestamps, speaker labels or any commentary.`;

export type Transcript = {
  /** Words in spoken order. Timing is added later from the measured audio. */
  words: string[];
  text: string;
};

export type TranscribeResult =
  | { success: true; transcript: Transcript }
  | { success: false; error: string };

/**
 * Extracts a small mono audio file for transcription.
 *
 * Video is never uploaded for this: Gemini bills audio at roughly a tenth of
 * video per second, transcription cannot use the pixels, and a raw 4K clip is
 * a couple of hundred megabytes to push over the wire. 16kHz mono is the rate
 * speech recognition wants anyway.
 */
async function extractAudio(sourcePath: string): Promise<string> {
  const outputPath = path.join(tmpdir(), `ugc-speech-${randomUUID()}.m4a`);
  const result = await runFfmpeg([
    '-i', sourcePath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'aac',
    '-b:a', '64k',
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

    const response = await withTransientRetry(async () => {
      const uploaded = await client.files.upload({
        file: localAudio,
        config: { mimeType: 'audio/mp4' },
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
              { fileData: { fileUri: uploaded.uri, mimeType: 'audio/mp4' } },
              { text: TRANSCRIBE_PROMPT },
            ],
          },
        ],
        config: { responseMimeType: 'application/json' },
      });
    }, TRANSCRIBE_RETRY);

    // Metered before the response is inspected: the call was billed whether or
    // not the answer turns out to be usable.
    await recordUsage({
      kind: 'tagging',
      model: TRANSCRIBE_MODEL,
      usage: response.usageMetadata,
    });

    const raw = response.text ?? '';
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      speech?: boolean;
      text?: string;
    };

    if (parsed.speech === false || !parsed.text || !parsed.text.trim()) {
      return {
        success: false,
        error:
          'No speech was found in this recording. Talking mode needs a clip of you speaking to camera.',
      };
    }

    return { success: true, transcript: { text: parsed.text, words: wordsOf(parsed.text) } };
  } catch (error) {
    return { success: false, error: `Could not transcribe the recording: ${describeCause(error)}` };
  } finally {
    // A leaked temp file is smaller than a failed job, so cleanup never throws.
    if (audioPath) await unlink(audioPath).catch(() => {});
  }
}
