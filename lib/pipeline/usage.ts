import { db } from '@/db/client';
import { apiUsage } from '@/db/schema';

/**
 * What a Gemini response carries about what it cost.
 *
 * Typed structurally rather than imported from the SDK: only these three
 * numbers are wanted, they are all optional on the wire, and depending on the
 * SDK's exact response type here would make this file break whenever that type
 * is reshaped.
 */
type UsageMetadata = {
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  totalTokenCount?: number | null;
};

export type UsageKind = 'tagging' | 'planning';

/**
 * Per-million-token prices, in US dollars.
 *
 * Hardcoded because there is no pricing API to read them from, which makes them
 * the one number here that can silently go stale — if the dashboard's spend
 * figure ever looks wrong, check these first against current published pricing.
 * Overridable by environment variable so a price change does not require a
 * deploy.
 *
 * Deliberately not a per-model table: this project runs one model family, and a
 * lookup keyed on model name would return nothing (and silently report $0) the
 * first time the model string changes.
 */
function rates(): { input: number; output: number } {
  const input = Number(process.env.GEMINI_INPUT_COST_PER_MTOK ?? '0.30');
  const output = Number(process.env.GEMINI_OUTPUT_COST_PER_MTOK ?? '2.50');
  return {
    input: Number.isFinite(input) ? input : 0.3,
    output: Number.isFinite(output) ? output : 2.5,
  };
}

/** Dollar cost of a number of prompt and output tokens. */
export function costOf(promptTokens: number, outputTokens: number): number {
  const { input, output } = rates();
  return (promptTokens / 1_000_000) * input + (outputTokens / 1_000_000) * output;
}

/**
 * Records what one model call cost, from the counts the API reported.
 *
 * Never throws and never blocks the caller's result. A pipeline step that
 * succeeded must not be turned into a failure because a metering row could not
 * be written — the video is the product; this is bookkeeping. A dropped row
 * understates spend slightly, which is visible on the dashboard as usage that
 * does not match the provider's own console, and is a far smaller problem than
 * a failed render.
 */
export async function recordUsage(input: {
  jobId?: string | null;
  kind: UsageKind;
  model: string;
  usage: UsageMetadata | null | undefined;
}): Promise<void> {
  try {
    const promptTokens = input.usage?.promptTokenCount ?? 0;
    const outputTokens = input.usage?.candidatesTokenCount ?? 0;
    // Falls back to the sum rather than 0: some responses report the parts but
    // not the total, and a zero total would read as a free call.
    const totalTokens = input.usage?.totalTokenCount ?? promptTokens + outputTokens;

    await db.insert(apiUsage).values({
      jobId: input.jobId ?? null,
      kind: input.kind,
      model: input.model,
      promptTokens,
      outputTokens,
      totalTokens,
    });
  } catch (error) {
    console.warn(
      `Could not record ${input.kind} API usage: ${error instanceof Error ? error.message : error}`
    );
  }
}
