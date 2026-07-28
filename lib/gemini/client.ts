import { GoogleGenAI } from '@google/genai';
import { getRequiredEnv } from '@/lib/env';

let client: GoogleGenAI | undefined;

export function getGeminiClient(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({ apiKey: getRequiredEnv('GEMINI_API_KEY') });
  }
  return client;
}
