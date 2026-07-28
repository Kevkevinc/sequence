import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

const mockGenerateContent = vi.fn();

vi.mock('@/lib/gemini/client', () => ({
  getGeminiClient: () => ({ models: { generateContent: mockGenerateContent } }),
}));

import { db } from '@/db/client';
import { rawClips, segments, editPlans } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { planJob } from '@/lib/pipeline/director';
import { HOOK_STYLE_LIBRARY } from '@/lib/pipeline/hookLibrary';

/** Reads the prompt text the implementation sent on a given generateContent call. */
function promptTextOfCall(callIndex: number): string {
  const arg = mockGenerateContent.mock.calls[callIndex][0];
  return arg.contents[0].parts[0].text as string;
}

describe('planJob', () => {
  const CLERK_ID = 'test_clerk_user_director';
  let creatorId: string;
  let jobId: string;
  let clipAId: string;
  let clipBId: string;

  /** A response that satisfies every validation rule for the job built below. */
  function validResponse() {
    return {
      text: JSON.stringify({
        variations: [
          {
            segments: [
              { rawClipId: clipAId, startSeconds: 0, endSeconds: 8 },
              { rawClipId: clipBId, startSeconds: 2, endSeconds: 6 },
            ],
            hookText: 'POV: you just found the Cozy Hoodie everyone is talking about',
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
          {
            segments: [
              { rawClipId: clipBId, startSeconds: 0, endSeconds: 10 },
              { rawClipId: clipAId, startSeconds: 0, endSeconds: 8 },
            ],
            hookText: 'Things I wish I knew before buying this Cozy Hoodie',
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
        ],
      }),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const creator = await createCreatorIfNotExists(CLERK_ID);
    creatorId = creator.id;
    const job = await createJob({
      creatorId: creator.id,
      productName: 'Cozy Hoodie',
      sizingOverlayEnabled: false,
      lengthSeconds: 15,
      pacing: 'medium',
      variationCount: 2,
      clips: [
        { storageKey: 'clips/a.mp4', originalFilename: 'a.mp4' },
        { storageKey: 'clips/b.mp4', originalFilename: 'b.mp4' },
      ],
    });
    jobId = job.id;
    const clips = await db.select().from(rawClips).where(eq(rawClips.jobId, jobId));
    clipAId = clips[0].id;
    clipBId = clips[1].id;

    await db.delete(editPlans).where(eq(editPlans.jobId, jobId));
    await db.delete(segments).where(eq(segments.rawClipId, clipAId));
    await db.delete(segments).where(eq(segments.rawClipId, clipBId));
    await db.insert(segments).values([
      { rawClipId: clipAId, startSeconds: '0', endSeconds: '8', contentTag: 'whole-clip', qualityTag: 'high' },
      { rawClipId: clipBId, startSeconds: '0', endSeconds: '10', contentTag: 'whole-clip', qualityTag: 'medium' },
      { rawClipId: clipBId, startSeconds: '2', endSeconds: '6', contentTag: 'try-on', qualityTag: 'high' },
    ]);
  });

  it('produces and saves the requested number of variations', async () => {
    mockGenerateContent.mockResolvedValue(validResponse());

    const result = await planJob(jobId);

    expect(result).toEqual({ success: true, variationCount: 2 });

    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(2);
    expect(saved.map((p) => p.variationNumber).sort()).toEqual([1, 2]);

    const first = saved.find((p) => p.variationNumber === 1)!;
    expect(first.hookText).toBe('POV: you just found the Cozy Hoodie everyone is talking about');
    expect(first.segments).toEqual([
      { rawClipId: clipAId, startSeconds: 0, endSeconds: 8 },
      { rawClipId: clipBId, startSeconds: 2, endSeconds: 6 },
    ]);
  });

  it('asks the director model for JSON, sending the segment pool, job settings, and hook library', async () => {
    mockGenerateContent.mockResolvedValue(validResponse());

    await planJob(jobId);

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-pro',
        config: expect.objectContaining({ responseMimeType: 'application/json' }),
        contents: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            parts: expect.arrayContaining([expect.objectContaining({ text: expect.any(String) })]),
          }),
        ]),
      })
    );

    const prompt = promptTextOfCall(0);
    // Job settings must reach the model, or the plan cannot honour them.
    expect(prompt).toContain('Cozy Hoodie');
    expect(prompt).toContain('15');
    expect(prompt).toContain('medium');
    expect(prompt).toContain('2');
    // The full segment pool must be offered, both clips included.
    expect(prompt).toContain(clipAId);
    expect(prompt).toContain(clipBId);
    // Hook styles are references the model adapts from.
    expect(prompt).toContain(HOOK_STYLE_LIBRARY[0]);
    expect(prompt).toContain(HOOK_STYLE_LIBRARY[HOOK_STYLE_LIBRARY.length - 1]);
    // No correction note on a first attempt.
    expect(prompt).not.toContain('previous response was invalid');
  });

  it('retries with the validation failure as a correction note and succeeds on the retry', async () => {
    mockGenerateContent
      .mockResolvedValueOnce({ text: JSON.stringify({ variations: [{ hookText: 'no segments here' }] }) })
      .mockResolvedValueOnce(validResponse());

    const result = await planJob(jobId);

    expect(result).toEqual({ success: true, variationCount: 2 });
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);

    // The second prompt must actually carry the reason the first was rejected,
    // otherwise the retry is just a blind re-roll.
    const retryPrompt = promptTextOfCall(1);
    expect(retryPrompt).toContain('previous response was invalid');
    expect(retryPrompt).toContain('segments');

    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(2);
  });

  it('returns a failure result when Gemini output fails schema validation twice', async () => {
    mockGenerateContent.mockResolvedValue({ text: 'not valid json' });

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    if (!result.success) {
      // The underlying cause must survive so a failed job can be diagnosed.
      expect(result.error).toMatch(/valid edit plan after 3 attempts: .+/);
    }

    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(0);
  });

  it('rejects a variation referencing a clip that does not belong to the job', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        variations: [
          {
            segments: [{ rawClipId: '00000000-0000-0000-0000-000000000000', startSeconds: 0, endSeconds: 8 }],
            hookText: 'Nobody told me this Cozy Hoodie would look this good',
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
          {
            segments: [{ rawClipId: clipAId, startSeconds: 0, endSeconds: 8 }],
            hookText: '3 reasons I am obsessed with this Cozy Hoodie',
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
        ],
      }),
    });

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    expect(promptTextOfCall(1)).toContain('previous response was invalid');
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(0);
  });

  it('rejects a variation reaching past the end of its clip footage', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        variations: [
          {
            segments: [{ rawClipId: clipAId, startSeconds: 0, endSeconds: 99 }],
            hookText: 'Wait until you see how this Cozy Hoodie fits',
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
          {
            segments: [{ rawClipId: clipAId, startSeconds: 0, endSeconds: 8 }],
            hookText: 'Is this Cozy Hoodie actually worth the hype?',
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
        ],
      }),
    });

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(0);
  });

  it('rejects a variation that repeats the same segment back to back', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        variations: [
          {
            segments: [
              { rawClipId: clipAId, startSeconds: 0, endSeconds: 8 },
              { rawClipId: clipAId, startSeconds: 0, endSeconds: 8 },
            ],
            hookText: 'You NEED this Cozy Hoodie',
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
          {
            segments: [{ rawClipId: clipBId, startSeconds: 0, endSeconds: 10 }],
            hookText: 'Things I wish I knew before buying this Cozy Hoodie',
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
        ],
      }),
    });

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(0);
  });

  it('rejects a response that does not contain the requested number of variations', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        variations: [
          {
            segments: [{ rawClipId: clipAId, startSeconds: 0, endSeconds: 8 }],
            hookText: 'Only one variation when two were requested',
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
        ],
      }),
    });

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    expect(promptTextOfCall(2)).toContain('previous response was invalid');
  });

  it('replaces existing plans instead of duplicating them when re-run', async () => {
    mockGenerateContent.mockResolvedValue(validResponse());

    await planJob(jobId);
    const second = await planJob(jobId);

    expect(second).toEqual({ success: true, variationCount: 2 });
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(2);
  });

  it('drops overlay copy the model volunteers when the job disabled the sizing overlay', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        variations: [
          {
            segments: [{ rawClipId: clipAId, startSeconds: 0, endSeconds: 8 }],
            hookText: 'Nobody told me this Cozy Hoodie would look this good',
            sizingOverlayText: '5\'6" wearing size M',
            sizingOverlayPlacement: 'bottom-left',
          },
          {
            segments: [{ rawClipId: clipBId, startSeconds: 0, endSeconds: 10 }],
            hookText: '3 reasons I am obsessed with this Cozy Hoodie',
            sizingOverlayText: '5\'6" wearing size M',
            sizingOverlayPlacement: 'bottom-left',
          },
        ],
      }),
    });

    const result = await planJob(jobId);

    expect(result).toEqual({ success: true, variationCount: 2 });
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved.map((p) => p.sizingOverlayText)).toEqual([null, null]);
    expect(saved.map((p) => p.sizingOverlayPlacement)).toEqual([null, null]);
    // The prompt should not ask for overlay copy the job turned off.
    expect(promptTextOfCall(0)).not.toContain('sizing overlay');
  });

  it('asks for sizing overlay copy and keeps it when the job enabled the overlay', async () => {
    const overlayJob = await createJob({
      creatorId,
      productName: 'Cozy Hoodie',
      sizeWorn: 'M',
      sizingOverlayEnabled: true,
      lengthSeconds: 15,
      pacing: 'fast',
      variationCount: 1,
      clips: [{ storageKey: 'clips/c.mp4', originalFilename: 'c.mp4' }],
    });
    const [clipC] = await db.select().from(rawClips).where(eq(rawClips.jobId, overlayJob.id));
    await db.insert(segments).values([
      { rawClipId: clipC.id, startSeconds: '0', endSeconds: '12', contentTag: 'whole-clip', qualityTag: 'high' },
    ]);

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        variations: [
          {
            segments: [{ rawClipId: clipC.id, startSeconds: 0, endSeconds: 12 }],
            hookText: 'Wait until you see how this Cozy Hoodie fits',
            sizingOverlayText: 'Wearing size M',
            sizingOverlayPlacement: 'bottom-center',
          },
        ],
      }),
    });

    const result = await planJob(overlayJob.id);

    expect(result).toEqual({ success: true, variationCount: 1 });
    expect(promptTextOfCall(0)).toContain('sizing overlay');
    expect(promptTextOfCall(0)).toContain('size worn: M');

    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, overlayJob.id));
    expect(saved).toHaveLength(1);
    expect(saved[0].sizingOverlayText).toBe('Wearing size M');
    expect(saved[0].sizingOverlayPlacement).toBe('bottom-center');
  });

  it('returns a failure result instead of throwing when the job has no segments', async () => {
    const emptyJob = await createJob({
      creatorId,
      productName: 'Untagged Product',
      sizingOverlayEnabled: false,
      lengthSeconds: 15,
      pacing: 'slow',
      variationCount: 2,
      clips: [{ storageKey: 'clips/untagged.mp4', originalFilename: 'untagged.mp4' }],
    });

    const result = await planJob(emptyJob.id);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('segments');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('returns a failure result instead of throwing when the job does not exist', async () => {
    const result = await planJob('00000000-0000-0000-0000-000000000000');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('00000000-0000-0000-0000-000000000000');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});
