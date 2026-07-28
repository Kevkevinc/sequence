import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

const mockGenerateContent = vi.fn();

vi.mock('@/lib/gemini/client', () => ({
  getGeminiClient: () => ({ models: { generateContent: mockGenerateContent } }),
}));

import { db } from '@/db/client';
import { creators, jobs, rawClips, segments, editPlans } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { planJob } from '@/lib/pipeline/director';
import { HOOK_STYLE_LIBRARY } from '@/lib/pipeline/hookLibrary';

// The creator's stored profile is the only legitimate source of overlay measurements.
const CREATOR_HEIGHT = '5\'6"';
const CREATOR_WEIGHT = '140 lb';

type SegmentSelection = { rawClipId: string; startSeconds: number; endSeconds: number };
type Variation = {
  segments: SegmentSelection[];
  hookText: string;
  sizingOverlayText: string | null;
  sizingOverlayPlacement: string | null;
};

function geminiResponse(variations: Variation[]) {
  return { text: JSON.stringify({ variations }) };
}

/** Reads the prompt text the implementation sent on a given generateContent call. */
function promptTextOfCall(callIndex: number): string {
  const arg = mockGenerateContent.mock.calls[callIndex][0];
  return arg.contents[0].parts[0].text as string;
}

describe('planJob', () => {
  const CLERK_ID = 'test_clerk_user_director';
  const CLERK_ID_NO_PROFILE = 'test_clerk_user_director_no_profile';
  let creatorId: string;
  let jobId: string;
  let clipAId: string;
  let clipBId: string;

  // Pool: clip A has 0-8s of footage; clip B has 0-10s, with a 2-6s try-on moment.
  const segA = (startSeconds: number, endSeconds: number): SegmentSelection => ({
    rawClipId: clipAId,
    startSeconds,
    endSeconds,
  });
  const segB = (startSeconds: number, endSeconds: number): SegmentSelection => ({
    rawClipId: clipBId,
    startSeconds,
    endSeconds,
  });

  function variation(segments: SegmentSelection[], hookText: string): Variation {
    return { segments, hookText, sizingOverlayText: null, sizingOverlayPlacement: null };
  }

  const HOOK_ONE = 'POV: you just found the Cozy Hoodie everyone is talking about';
  const HOOK_TWO = 'Things I wish I knew before buying this Cozy Hoodie';
  // 16s and 15s, both within 15% of the job's 15s target, and every cut inside
  // the 2.25-5s band that "medium" pacing means.
  const validVariationOne = () =>
    variation([segA(0, 4), segB(0, 4), segA(4, 8), segB(4, 8)], HOOK_ONE);
  const validVariationTwo = () =>
    variation([segB(0, 3.5), segA(0, 3.5), segB(6, 10), segA(4, 8)], HOOK_TWO);
  const validResponse = () => geminiResponse([validVariationOne(), validVariationTwo()]);

  /**
   * Creates a single-clip, single-variation job with the sizing overlay enabled.
   * Slow pacing (3.75-7.5s per cut) so its 15s of footage is three clean cuts.
   */
  async function createOverlayJob(options: { sizeWorn?: string; creatorId?: string }) {
    const overlayJob = await createJob({
      creatorId: options.creatorId ?? creatorId,
      productName: 'Cozy Hoodie',
      sizeWorn: options.sizeWorn,
      sizingOverlayEnabled: true,
      lengthSeconds: 15,
      pacing: 'slow',
      variationCount: 1,
      clips: [{ storageKey: 'clips/c.mp4', originalFilename: 'c.mp4' }],
    });
    const [clip] = await db.select().from(rawClips).where(eq(rawClips.jobId, overlayJob.id));
    await db.insert(segments).values([
      { rawClipId: clip.id, startSeconds: '0', endSeconds: '15', contentTag: 'whole-clip', qualityTag: 'high' },
    ]);
    return { id: overlayJob.id, clipId: clip.id };
  }

  /**
   * A one-variation overlay response with the given model-authored lead-in.
   * 15s from a single 15s clip: 1.5s of footage is discarded at the one
   * same-clip splice so the cut is actually visible, and the opening shot
   * returns at the end as a bookend.
   */
  function overlayResponse(clipId: string, sizingOverlayText: string | null, placement = 'bottom-center') {
    return geminiResponse([
      {
        segments: [
          { rawClipId: clipId, startSeconds: 0, endSeconds: 5 },
          { rawClipId: clipId, startSeconds: 6.5, endSeconds: 11.5 },
          { rawClipId: clipId, startSeconds: 0, endSeconds: 5 },
        ],
        hookText: 'Wait until you see how this Cozy Hoodie fits',
        sizingOverlayText,
        sizingOverlayPlacement: placement,
      },
    ]);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const creator = await createCreatorIfNotExists(CLERK_ID);
    creatorId = creator.id;
    // Pin the profile explicitly so the overlay assertions do not depend on
    // whatever a previous run happened to leave in the row.
    await db
      .update(creators)
      .set({ height: CREATOR_HEIGHT, weight: CREATOR_WEIGHT })
      .where(eq(creators.id, creatorId));

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

    expect(result).toEqual({ success: true, variationCount: 2, warning: null });

    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(2);
    expect(saved.map((p) => p.variationNumber).sort()).toEqual([1, 2]);

    const first = saved.find((p) => p.variationNumber === 1)!;
    expect(first.hookText).toBe(HOOK_ONE);
    expect(first.segments).toEqual(validVariationOne().segments);
  });

  it('asks the director model for JSON, sending the segment pool, job settings, and hook library', async () => {
    mockGenerateContent.mockResolvedValue(validResponse());

    await planJob(jobId);

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.6-flash',
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
    // Pool times must be numbers, not drizzle's numeric strings: the response
    // schema demands numbers, so sending strings invites avoidable retries.
    expect(prompt).toContain('"startSeconds":0');
    expect(prompt).not.toContain('"startSeconds":"');
    expect(prompt).not.toContain('"endSeconds":"');
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

    expect(result).toEqual({ success: true, variationCount: 2, warning: null });
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
    const foreign: SegmentSelection = {
      rawClipId: '00000000-0000-0000-0000-000000000000',
      startSeconds: 0,
      endSeconds: 4,
    };
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        variation([foreign, segB(0, 4), segA(0, 4), segB(4, 8)], HOOK_ONE),
        validVariationTwo(),
      ])
    );

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    expect(promptTextOfCall(1)).toContain('previous response was invalid');
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(0);
  });

  it('rejects a variation reaching past the end of its clip footage', async () => {
    // Totals 14.5s with every cut inside the pacing band and a discarded gap at
    // each same-clip splice, so only the overrun is at fault.
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        variation([segA(0, 4), segA(5.5, 8), segB(0, 4), segB(7, 11)], HOOK_ONE),
        validVariationTwo(),
      ])
    );

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('usable footage');
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(0);
  });

  it('rejects a variation that repeats the same segment back to back', async () => {
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        // 16s with every cut in the pacing band: duration is fine, order is not.
        variation([segA(0, 4), segA(0, 4), segB(0, 4), segB(5, 9)], HOOK_ONE),
        validVariationTwo(),
      ])
    );

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('consecutive');
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(0);
  });

  it('rejects a variation whose cuts do not sum to near the target length', async () => {
    // 8s against a 15s target: outside the 13.5s - 17.25s window. Both cuts sit
    // inside the pacing band, so the total is the only thing wrong.
    mockGenerateContent.mockResolvedValue(
      geminiResponse([variation([segA(0, 4), segB(0, 4)], HOOK_ONE), validVariationTwo()])
    );

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    if (!result.success) expect(result.error).toContain('total duration');
    // The retry must be told which rule it broke.
    expect(promptTextOfCall(1)).toContain('total duration');
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(0);
  });

  it('accepts variations sitting exactly on the duration tolerance boundaries', async () => {
    // 13.5s (-10%) and 17.25s (+15%) are the extremes of the allowed window for
    // a 15s target. The band is asymmetric: the floor was tightened because the
    // live run consistently stopped short, the ceiling was left alone.
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        variation([segA(0, 4), segB(0, 4), segA(5, 8), segB(5, 7.5)], HOOK_ONE),
        variation([segB(0, 4.625), segA(0, 4), segB(4.625, 9.25), segA(4, 8)], HOOK_TWO),
      ])
    );

    const result = await planJob(jobId);

    expect(result).toEqual({ success: true, variationCount: 2, warning: null });
  });

  it('rejects a response that does not contain the requested number of variations', async () => {
    mockGenerateContent.mockResolvedValue(geminiResponse([validVariationOne()]));

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    expect(promptTextOfCall(2)).toContain('previous response was invalid');
  });

  it('rejects an overlay placement outside the set the prompt offers', async () => {
    const overlayJob = await createOverlayJob({ sizeWorn: 'M' });
    mockGenerateContent.mockResolvedValue(
      overlayResponse(overlayJob.clipId, 'For reference', 'middle-of-nowhere')
    );

    const result = await planJob(overlayJob.id);

    expect(result.success).toBe(false);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, overlayJob.id));
    expect(saved).toHaveLength(0);
  });

  it('replaces existing plans instead of duplicating them when re-run', async () => {
    mockGenerateContent.mockResolvedValue(validResponse());

    await planJob(jobId);
    const second = await planJob(jobId);

    expect(second).toEqual({ success: true, variationCount: 2, warning: null });
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(2);
  });

  it('drops overlay copy the model volunteers when the job disabled the sizing overlay', async () => {
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        { ...validVariationOne(), sizingOverlayText: 'For reference', sizingOverlayPlacement: 'bottom-left' },
        { ...validVariationTwo(), sizingOverlayText: 'Fit check', sizingOverlayPlacement: 'bottom-left' },
      ])
    );

    const result = await planJob(jobId);

    expect(result).toEqual({ success: true, variationCount: 2, warning: null });
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved.map((p) => p.sizingOverlayText)).toEqual([null, null]);
    expect(saved.map((p) => p.sizingOverlayPlacement)).toEqual([null, null]);
    // The prompt should not ask for overlay copy the job turned off.
    expect(promptTextOfCall(0)).not.toContain('sizing overlay');
  });

  it('builds the overlay caption from the stored profile, keeping only the model lead-in', async () => {
    const overlayJob = await createOverlayJob({ sizeWorn: 'M' });
    mockGenerateContent.mockResolvedValue(overlayResponse(overlayJob.clipId, 'For reference'));

    const result = await planJob(overlayJob.id);

    expect(result).toEqual({ success: true, variationCount: 1, warning: null });
    expect(promptTextOfCall(0)).toContain('sizing overlay');
    expect(promptTextOfCall(0)).toContain('size worn: M');

    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, overlayJob.id));
    expect(saved).toHaveLength(1);
    // Every measurement comes from the creator row and the job, never the model.
    expect(saved[0].sizingOverlayText).toBe(
      `For reference ${CREATOR_HEIGHT} · ${CREATOR_WEIGHT} · size M`
    );
    expect(saved[0].sizingOverlayPlacement).toBe('bottom-center');
  });

  it('uses the stored measurements alone when the model supplies no lead-in', async () => {
    const overlayJob = await createOverlayJob({ sizeWorn: 'M' });
    mockGenerateContent.mockResolvedValue(overlayResponse(overlayJob.clipId, null));

    const result = await planJob(overlayJob.id);

    expect(result).toEqual({ success: true, variationCount: 1, warning: null });
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, overlayJob.id));
    expect(saved[0].sizingOverlayText).toBe(`${CREATOR_HEIGHT} · ${CREATOR_WEIGHT} · size M`);
  });

  it('rejects model-authored body measurements in the overlay text', async () => {
    const overlayJob = await createOverlayJob({ sizeWorn: 'M' });
    // Invented stats: the model is never told the creator's real ones.
    mockGenerateContent.mockResolvedValue(
      overlayResponse(overlayJob.clipId, '5\'8", 165 lbs, wearing size M')
    );

    const result = await planJob(overlayJob.id);

    expect(result.success).toBe(false);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    if (!result.success) expect(result.error).toContain('measurement');
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, overlayJob.id));
    expect(saved).toHaveLength(0);
  });

  it.each([
    ['metric height', '172 cm tall'],
    ['metric weight', 'about 65kg'],
    ['imperial height', '5 ft 8 in'],
    ['spelled-out weight', '165 pounds'],
  ])('rejects overlay text containing a %s', async (_label, overlayText) => {
    const overlayJob = await createOverlayJob({ sizeWorn: 'M' });
    mockGenerateContent.mockResolvedValue(overlayResponse(overlayJob.clipId, overlayText));

    const result = await planJob(overlayJob.id);

    expect(result.success).toBe(false);
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, overlayJob.id));
    expect(saved).toHaveLength(0);
  });

  it('degrades to the size worn when the creator has not filled in their measurements', async () => {
    const blankCreator = await createCreatorIfNotExists(CLERK_ID_NO_PROFILE);
    await db
      .update(creators)
      .set({ height: null, weight: null })
      .where(eq(creators.id, blankCreator.id));
    const overlayJob = await createOverlayJob({ sizeWorn: 'L', creatorId: blankCreator.id });

    mockGenerateContent.mockResolvedValue(overlayResponse(overlayJob.clipId, null, 'top-left'));

    const result = await planJob(overlayJob.id);

    expect(result).toEqual({ success: true, variationCount: 1, warning: null });
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, overlayJob.id));
    expect(saved[0].sizingOverlayText).toBe('size L');
    expect(saved[0].sizingOverlayPlacement).toBe('top-left');
  });

  it('stores no overlay at all when neither the profile nor the job has anything true to show', async () => {
    const blankCreator = await createCreatorIfNotExists(CLERK_ID_NO_PROFILE);
    await db
      .update(creators)
      .set({ height: null, weight: null })
      .where(eq(creators.id, blankCreator.id));
    const overlayJob = await createOverlayJob({ creatorId: blankCreator.id });

    mockGenerateContent.mockResolvedValue(overlayResponse(overlayJob.clipId, 'For reference'));

    const result = await planJob(overlayJob.id);

    expect(result).toEqual({ success: true, variationCount: 1, warning: null });
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, overlayJob.id));
    // A placement with no caption would render an empty overlay box.
    expect(saved[0].sizingOverlayText).toBeNull();
    expect(saved[0].sizingOverlayPlacement).toBeNull();
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

  describe('segment reuse cap', () => {
    // Two short cuts from the existing pool, so a variation can hit the 15s
    // target while still repeating one of them several times. That isolates the
    // reuse rule: every other rule in the validator is satisfied.
    const shortCut = () => segB(2, 6); // 4s
    const spacer = () => segA(0, 2.5); // 2.5s

    it('rejects a variation that uses the same segment three times', async () => {
      // 17s total and no back-to-back repeat: legal under every rule the first
      // live run had, which is exactly how it looped 3 segments 12 times.
      const overused = variation(
        [shortCut(), spacer(), shortCut(), spacer(), shortCut()],
        HOOK_ONE
      );
      mockGenerateContent.mockResolvedValue(geminiResponse([overused, validVariationTwo()]));

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('more than 2 times');
      // The cap must feed the correction-note loop, not just sit in the prompt.
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      expect(promptTextOfCall(1)).toContain('previous response was invalid');
      expect(promptTextOfCall(1)).toContain('more than 2 times');

      const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
      expect(saved).toHaveLength(0);
    });

    it('still allows a segment to be used twice', async () => {
      // 15.5s: the cap is a cap, not a ban on reuse.
      const reusedTwice = variation(
        [shortCut(), segA(0, 4), shortCut(), segA(4, 7.5)],
        HOOK_ONE
      );
      mockGenerateContent.mockResolvedValue(geminiResponse([reusedTwice, validVariationTwo()]));

      const result = await planJob(jobId);

      expect(result).toEqual({ success: true, variationCount: 2, warning: null });
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('tells the model the reuse limit up front', async () => {
      mockGenerateContent.mockResolvedValue(validResponse());

      await planJob(jobId);

      expect(promptTextOfCall(0)).toContain('never more than 2 times');
    });

    it('catches a repeat disguised by nudged cut boundaries', async () => {
      // Three cuts of the same moment under three slightly different
      // boundaries: five distinct rawClipId|start|end keys, so exact-match
      // counting let this through. 15s total, every cut in the pacing band and
      // no back-to-back repeat, so the reuse rule is the only thing at fault.
      const disguised = variation(
        [segA(0, 3), segB(0, 3), segA(0.2, 3.2), segB(4, 7), segA(0.4, 3.4)],
        HOOK_ONE
      );
      mockGenerateContent.mockResolvedValue(geminiResponse([disguised, validVariationTwo()]));

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('more than 2 times');
      expect(promptTextOfCall(1)).toContain('more than 2 times');
      const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
      expect(saved).toHaveLength(0);
    });

    it('catches the same moment repeated back to back under nudged boundaries', async () => {
      // 16s, both cuts in the band, only 0.1s apart: distinct keys, same shot.
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          variation([segA(0, 4), segA(0.1, 4.1), segB(0, 4), segB(5, 9)], HOOK_ONE),
          validVariationTwo(),
        ])
      );

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('consecutive');
    });

    it('treats non-overlapping cuts from one clip as distinct footage', async () => {
      // Each clip subdivided into two cuts with 1.5s of footage discarded
      // between them: same clip twice in a row, but never the same moment, and
      // never chronologically adjacent. This is the behaviour the pacing rule
      // depends on, so it must not read as reuse.
      const subdivided = variation(
        [segA(0, 3.5), segA(5, 8), segB(0, 3.5), segB(5, 9.5)],
        HOOK_ONE
      );
      mockGenerateContent.mockResolvedValue(geminiResponse([subdivided, validVariationTwo()]));

      const result = await planJob(jobId);

      expect(result).toEqual({ success: true, variationCount: 2, warning: null });
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('allows cuts that overlap by exactly half, so staggered subdivision stays open', async () => {
      // 0-4 / 2-6 / 4-8 each share half of their length with their neighbour:
      // the majority of every cut is still footage the viewer has not seen.
      const staggered = variation([segA(0, 4), segA(2, 6), segA(4, 8), segB(0, 4)], HOOK_ONE);
      mockGenerateContent.mockResolvedValue(geminiResponse([staggered, validVariationTwo()]));

      const result = await planJob(jobId);

      expect(result).toEqual({ success: true, variationCount: 2, warning: null });
    });

    it('tells the model that overlapping cuts count as the same moment', async () => {
      mockGenerateContent.mockResolvedValue(validResponse());

      await planJob(jobId);

      const prompt = promptTextOfCall(0);
      expect(prompt).toContain('overlap by');
      expect(prompt).toContain('0-8 then 0.1-8');
    });
  });

  describe('when there is not enough footage to fill the target length', () => {
    // 7s of distinct footage against a 30s target: with the reuse cap the pool
    // can fill 14s at most, so the +-15% rule is unreachable. This is the shape
    // of the first live run, where 3 short clips got looped 12 times each.
    // 1.25s of footage is discarded between the two cuts so the splice between
    // them is a visible cut rather than the take playing straight through.
    const CUT_ONE = { startSeconds: 0, endSeconds: 3 };
    const CUT_TWO = { startSeconds: 4.25, endSeconds: 7 };

    let shortJobId: string;
    let shortClipId: string;

    beforeEach(async () => {
      const shortJob = await createJob({
        creatorId,
        productName: 'Cozy Hoodie',
        sizingOverlayEnabled: false,
        lengthSeconds: 30,
        pacing: 'medium',
        variationCount: 1,
        clips: [{ storageKey: 'clips/short.mp4', originalFilename: 'short.mp4' }],
      });
      shortJobId = shortJob.id;
      const [clip] = await db.select().from(rawClips).where(eq(rawClips.jobId, shortJobId));
      shortClipId = clip.id;
      await db.insert(segments).values([
        { rawClipId: shortClipId, startSeconds: '0', endSeconds: '4', contentTag: 'whole-clip', qualityTag: 'high' },
        { rawClipId: shortClipId, startSeconds: '4', endSeconds: '7', contentTag: 'b-roll', qualityTag: 'medium' },
      ]);
    });

    /** A one-variation response built from the short clip's cuts, in order. */
    function shortResponse(cuts: { startSeconds: number; endSeconds: number }[]) {
      return geminiResponse([
        {
          segments: cuts.map((cut) => ({ rawClipId: shortClipId, ...cut })),
          hookText: HOOK_ONE,
          sizingOverlayText: null,
          sizingOverlayPlacement: null,
        },
      ]);
    }

    async function warningOf(id: string) {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
      return row.warning;
    }

    it('accepts a short video rather than failing the job', async () => {
      // 11.5s against a 30s target: nowhere near the accepted band, but it is
      // every second the footage honestly has, which beats a padded 30s.
      mockGenerateContent.mockResolvedValue(shortResponse([CUT_ONE, CUT_TWO, CUT_ONE, CUT_TWO]));

      const result = await planJob(shortJobId);

      expect(result.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, shortJobId));
      expect(saved).toHaveLength(1);
    });

    it('records a plain-language warning on the job so the creator can be told', async () => {
      mockGenerateContent.mockResolvedValue(shortResponse([CUT_ONE, CUT_TWO, CUT_ONE, CUT_TWO]));

      const result = await planJob(shortJobId);

      const expected =
        'Only 7s of usable footage was available, so your videos are shorter than the 30s you ' +
        'requested. Upload more clips for full-length videos.';
      expect(result).toEqual({ success: true, variationCount: 1, warning: expected });
      expect(await warningOf(shortJobId)).toBe(expected);
    });

    it('clears a stale warning when the job is re-planned with enough footage', async () => {
      mockGenerateContent.mockResolvedValue(shortResponse([CUT_ONE, CUT_TWO, CUT_ONE, CUT_TWO]));
      await planJob(shortJobId);
      expect(await warningOf(shortJobId)).not.toBeNull();

      // The creator uploads more: 30s of new footage now covers the target.
      const [extraClip] = await db
        .insert(rawClips)
        .values({ jobId: shortJobId, storageKey: 'clips/extra.mp4', originalFilename: 'extra.mp4' })
        .returning();
      await db.insert(segments).values([
        { rawClipId: extraClip.id, startSeconds: '0', endSeconds: '30', contentTag: 'whole-clip', qualityTag: 'high' },
      ]);
      // 31.5s of medium-paced cuts: five 4.5s pieces spaced 1.5s apart down the
      // new clip, then the first two again as a callback.
      const spacedCuts = [
        [0, 4.5],
        [6, 10.5],
        [12, 16.5],
        [18, 22.5],
        [24, 28.5],
        [0, 4.5],
        [6, 10.5],
      ];
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          {
            segments: spacedCuts.map(([startSeconds, endSeconds]) => ({
              rawClipId: extraClip.id,
              startSeconds,
              endSeconds,
            })),
            hookText: HOOK_ONE,
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
        ])
      );

      const result = await planJob(shortJobId);

      expect(result).toEqual({ success: true, variationCount: 1, warning: null });
      expect(await warningOf(shortJobId)).toBeNull();
    });

    it('still rejects a plan that throws away footage it could have used', async () => {
      // 3s when 14s was achievable: the relaxed rule is "best achievable", not
      // "any length goes".
      mockGenerateContent.mockResolvedValue(shortResponse([CUT_ONE]));

      const result = await planJob(shortJobId);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('wastes the available footage');
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, shortJobId));
      expect(saved).toHaveLength(0);
    });

    it('still enforces the reuse cap, so the fallback cannot be padded either', async () => {
      // 17.25s: closer to the 30s target than the honest 11.5s, and exactly the
      // kind of padding this whole path exists to prevent.
      mockGenerateContent.mockResolvedValue(
        shortResponse([CUT_ONE, CUT_TWO, CUT_ONE, CUT_TWO, CUT_ONE, CUT_TWO])
      );

      const result = await planJob(shortJobId);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('more than 2 times');
    });

    it('tells the model the real ceiling instead of the target it cannot reach', async () => {
      mockGenerateContent.mockResolvedValue(shortResponse([CUT_ONE, CUT_TWO, CUT_ONE, CUT_TWO]));

      await planJob(shortJobId);

      const prompt = promptTextOfCall(0);
      expect(prompt).toContain('only 7s of distinct footage');
      expect(prompt).toContain('about 14s per variation');
      expect(prompt).toContain('shorter video is');
      // The unreachable rule must not also be asserted, or the model is being
      // told to satisfy two contradictory instructions.
      expect(prompt).not.toContain('AIM FOR 30 SECONDS');
    });

    it('counts overlapping tags on one clip once, not twice', async () => {
      // The tagger always emits a whole-clip segment plus the good moments
      // inside it, so a 10s clip arrives as 14s of tagged segments. Summing
      // those would call this job "sufficient" and licence showing 10s of
      // footage three times over to reach 30s.
      const overlapJob = await createJob({
        creatorId,
        productName: 'Cozy Hoodie',
        sizingOverlayEnabled: false,
        lengthSeconds: 30,
        pacing: 'medium',
        variationCount: 1,
        clips: [{ storageKey: 'clips/overlap.mp4', originalFilename: 'overlap.mp4' }],
      });
      const [clip] = await db.select().from(rawClips).where(eq(rawClips.jobId, overlapJob.id));
      await db.insert(segments).values([
        { rawClipId: clip.id, startSeconds: '0', endSeconds: '10', contentTag: 'whole-clip', qualityTag: 'high' },
        { rawClipId: clip.id, startSeconds: '2', endSeconds: '6', contentTag: 'try-on', qualityTag: 'high' },
      ]);
      // 10s of footage cut two ways and shown twice: 16s, close to the honest
      // 20s ceiling once the discarded gaps are paid for.
      const cuts = [
        { startSeconds: 0, endSeconds: 4 },
        { startSeconds: 5.5, endSeconds: 9.5 },
      ];
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          {
            segments: [...cuts, ...cuts].map((cut) => ({ rawClipId: clip.id, ...cut })),
            hookText: HOOK_ONE,
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
        ])
      );

      const result = await planJob(overlapJob.id);

      expect(result.success).toBe(true);
      // 10s of real footage, not the 14s the tagged rows add up to.
      expect(await warningOf(overlapJob.id)).toContain('Only 10s of usable footage');
    });

    it('leaves the target-length rule in force when the footage is sufficient', async () => {
      // The normal job's pool is ample, so the fallback must not apply to it.
      mockGenerateContent.mockResolvedValue(
        geminiResponse([variation([segA(0, 4), segB(0, 4)], HOOK_ONE), validVariationTwo()])
      );

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('total duration');
      expect(promptTextOfCall(0)).toContain('AIM FOR 15 SECONDS');
      expect(await warningOf(jobId)).toBeNull();
    });
  });

  describe('pacing', () => {
    // The job under test is 15s at "medium" pacing: every cut must last between
    // 2.25s and 5s, and a 15s video is roughly four of them.

    it('rejects a variation that opens on one long unbroken shot', async () => {
      // The live run's failure: 16s total, inside the duration tolerance and
      // legal under every other rule, but the first cut runs 8s.
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          variation([segA(0, 8), segB(0, 4), segB(5, 9)], HOOK_ONE),
          validVariationTwo(),
        ])
      );

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      if (!result.success) expect(result.error).toContain('pacing');
      // The rule has to reach the model, not just fail the job.
      const retryPrompt = promptTextOfCall(1);
      expect(retryPrompt).toContain('previous response was invalid');
      expect(retryPrompt).toContain('this cut is 8s long');
      expect(retryPrompt).toContain('between 2.25s and 5s');
      expect(retryPrompt).toContain('Split this footage into shorter cuts');

      const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
      expect(saved).toHaveLength(0);
    });

    it('rejects a cut that is too short for the pacing preset', async () => {
      // 14s total, but the second cut is a 1.5s flash mid-video.
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          variation([segA(0, 4), segB(0, 1.5), segA(4, 8), segB(4, 8.5)], HOOK_ONE),
          validVariationTwo(),
        ])
      );

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      expect(promptTextOfCall(1)).toContain('this cut is only 1.5s long');
    });

    it('allows a short final cut so a variation can land on the target length', async () => {
      // 14s: the tail cut is 1.5s, above the 1.125s floor the last cut gets.
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          variation([segA(0, 4), segB(0, 4.5), segA(4, 8), segB(5, 6.5)], HOOK_ONE),
          validVariationTwo(),
        ])
      );

      const result = await planJob(jobId);

      expect(result).toEqual({ success: true, variationCount: 2, warning: null });
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('never lets the final cut run long, only short', async () => {
      // 16.25s total and the overrun is only 0.25s past the band, but a long
      // tail cut is exactly the defect this rule exists to catch.
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          variation([segA(0, 4), segB(0, 3.5), segA(4.5, 8), segB(4.75, 10)], HOOK_ONE),
          validVariationTwo(),
        ])
      );

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      expect(promptTextOfCall(1)).toContain('this cut is 5.25s long');
    });

    it('does not demand cuts longer than the entire usable footage of a clip', async () => {
      // A 3s clip in a slow job (3.75-7.5s per cut) can never produce a
      // band-length cut. Enforcing the floor here would make the job impossible.
      const tinyJob = await createJob({
        creatorId,
        productName: 'Cozy Hoodie',
        sizingOverlayEnabled: false,
        lengthSeconds: 15,
        pacing: 'slow',
        variationCount: 1,
        clips: [{ storageKey: 'clips/tiny.mp4', originalFilename: 'tiny.mp4' }],
      });
      const [clip] = await db.select().from(rawClips).where(eq(rawClips.jobId, tinyJob.id));
      await db.insert(segments).values([
        { rawClipId: clip.id, startSeconds: '0', endSeconds: '3', contentTag: 'whole-clip', qualityTag: 'high' },
      ]);
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          {
            segments: [{ rawClipId: clip.id, startSeconds: 0, endSeconds: 3 }],
            hookText: HOOK_ONE,
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
        ])
      );

      const result = await planJob(tinyJob.id);

      expect(result.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('states the per-cut band, the cut count, and how to subdivide', async () => {
      mockGenerateContent.mockResolvedValue(validResponse());

      await planJob(jobId);

      const prompt = promptTextOfCall(0);
      expect(prompt).toContain('between 2.25 and 5 seconds');
      expect(prompt).toContain('roughly 4 cuts');
      expect(prompt).toContain('RANGE YOU MAY CUT INSIDE');
      expect(prompt).toContain('SPLIT IT');
      expect(prompt).toContain('DIFFERENT POINTS');
    });

    it('states the band belonging to the job\'s own pacing preset', async () => {
      const slowJob = await createOverlayJob({ sizeWorn: 'M' });
      mockGenerateContent.mockResolvedValue(overlayResponse(slowJob.clipId, 'For reference'));

      await planJob(slowJob.id);

      // "slow" is 5-6s per cut, widened by the 25% tolerance.
      expect(promptTextOfCall(0)).toContain('between 3.75 and 7.5 seconds');
    });
  });

  describe('cuts the viewer can actually see', () => {
    // The second live run's defect: a 30s medium job answered with seven cuts
    // from one continuous take, chronologically consecutive. Every rule the
    // validator had passed, and the finished video contained no cuts at all.
    // Reproduced here on a 30s single-clip pool, one variation, so nothing else
    // can be at fault.
    let takeJobId: string;
    let takeClipId: string;

    beforeEach(async () => {
      const takeJob = await createJob({
        creatorId,
        productName: 'Cozy Hoodie',
        sizingOverlayEnabled: false,
        lengthSeconds: 30,
        pacing: 'medium',
        variationCount: 1,
        clips: [{ storageKey: 'clips/take.mp4', originalFilename: 'take.mp4' }],
      });
      takeJobId = takeJob.id;
      const [clip] = await db.select().from(rawClips).where(eq(rawClips.jobId, takeJobId));
      takeClipId = clip.id;
      await db.insert(segments).values([
        { rawClipId: takeClipId, startSeconds: '0', endSeconds: '30', contentTag: 'whole-clip', qualityTag: 'high' },
      ]);
    });

    /** A one-variation response cutting the single 30s take. */
    function takeResponse(cuts: number[][]) {
      return geminiResponse([
        {
          segments: cuts.map(([startSeconds, endSeconds]) => ({
            rawClipId: takeClipId,
            startSeconds,
            endSeconds,
          })),
          hookText: HOOK_ONE,
          sizingOverlayText: null,
          sizingOverlayPlacement: null,
        },
      ]);
    }

    it('rejects consecutive chronological ranges of one take, which show no cut at all', async () => {
      // The exact sequence the live run produced: 0-4, 4-8, 8-12, 12-16, 16-20,
      // 20-24, 24-27. Seven cuts, all inside the 2.25-5s band, none overlapping,
      // none repeated, and 27s exactly on the -10% duration floor - so the
      // visible-cut rule is the only thing that can reject it. Concatenated it
      // is the original take playing straight through.
      mockGenerateContent.mockResolvedValue(
        takeResponse([
          [0, 4],
          [4, 8],
          [8, 12],
          [12, 16],
          [16, 20],
          [20, 24],
          [24, 27],
        ])
      );

      const result = await planJob(takeJobId);

      expect(result.success).toBe(false);
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      if (!result.success) expect(result.error).toContain('no cut at all');
      // The rule has to reach the model, not merely fail the job.
      const retryPrompt = promptTextOfCall(1);
      expect(retryPrompt).toContain('previous response was invalid');
      expect(retryPrompt).toContain('with only 0s between them');
      expect(retryPrompt).toContain('no cut at all');

      const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, takeJobId));
      expect(saved).toHaveLength(0);
    });

    it('rejects the milder form: one adjacent pair inside an otherwise fine edit', async () => {
      // 12-16.5 followed immediately by 16.5-21, the shape the live run's other
      // variations took. Every other splice discards 1.5s, the total is 31.5s.
      mockGenerateContent.mockResolvedValue(
        takeResponse([
          [0, 4.5],
          [6, 10.5],
          [12, 16.5],
          [16.5, 21],
          [24, 28.5],
          [0, 4.5],
          [6, 10.5],
        ])
      );

      const result = await planJob(takeJobId);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('no cut at all');
    });

    it('accepts the same footage once a second of it is discarded at each splice', async () => {
      // The fix the product owner described: same clip, same coverage, but a
      // 1.5s break thrown away at every same-clip splice so each one reads as a
      // scene change. 31.5s against the 30s target.
      mockGenerateContent.mockResolvedValue(
        takeResponse([
          [0, 4.5],
          [6, 10.5],
          [12, 16.5],
          [18, 22.5],
          [24, 28.5],
          [0, 4.5],
          [6, 10.5],
        ])
      );

      const result = await planJob(takeJobId);

      expect(result).toEqual({ success: true, variationCount: 1, warning: null });
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('accepts a non-chronological order, because jumping backwards reads as a cut', async () => {
      // No discarded gaps needed: every splice jumps to a different part of the
      // clip, which is a visible change however the ranges are spaced.
      mockGenerateContent.mockResolvedValue(
        takeResponse([
          [12, 16.5],
          [6, 10.5],
          [18, 22.5],
          [0, 4.5],
          [24, 28.5],
          [12, 16.5],
          [6, 10.5],
        ])
      );

      const result = await planJob(takeJobId);

      expect(result).toEqual({ success: true, variationCount: 1, warning: null });
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('accepts a gap of exactly the one-second minimum', async () => {
      mockGenerateContent.mockResolvedValue(
        takeResponse([
          [0, 4],
          [5, 9],
          [10, 14],
          [15, 19],
          [20, 24],
          [0, 4],
          [5, 9],
        ])
      );

      const result = await planJob(takeJobId);

      expect(result).toEqual({ success: true, variationCount: 1, warning: null });
    });

    it('rejects a gap just under the one-second minimum', async () => {
      // 0.9s: identical to the accepted plan above but for a tenth of a second,
      // which pins where the line actually sits.
      mockGenerateContent.mockResolvedValue(
        takeResponse([
          [0, 4],
          [4.9, 8.9],
          [10, 14],
          [15, 19],
          [20, 24],
          [0, 4],
          [4.9, 8.9],
        ])
      );

      const result = await planJob(takeJobId);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('with only 0.9s between them');
    });

    it('leaves interleaved reuse of one clip alone, because another clip separates the pieces', async () => {
      // A(0-4), B(0-2.5), A(4-8): A's two halves are chronologically adjacent
      // but a cut to B sits between them, so the viewer plainly sees a change.
      // The rule must only look at neighbouring positions.
      const interleaved = variation(
        [segA(0, 4), segB(0, 2.5), segA(4, 8), segB(4, 8)],
        HOOK_ONE
      );
      mockGenerateContent.mockResolvedValue(
        geminiResponse([interleaved, validVariationTwo()])
      );

      const result = await planJob(jobId);

      expect(result).toEqual({ success: true, variationCount: 2, warning: null });
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('tells the model up front that adjacent ranges are not cuts', async () => {
      mockGenerateContent.mockResolvedValue(validResponse());

      await planJob(jobId);

      const prompt = promptTextOfCall(0);
      expect(prompt).toContain('EVERY CUT MUST BE VISIBLE');
      expect(prompt).toContain('WRONG: 0-4 then 4-8 then 8-12 from one clip');
      expect(prompt).toContain('leave at least 1s of footage OUT between them');
      expect(prompt).toContain('jump BACKWARDS');
    });
  });

  describe('aiming at the target length rather than the floor', () => {
    it('rejects a variation that stops 12% short of the target', async () => {
      // 13.2s against 15s. Legal under the old +-15% window (12.75s) and the
      // shape every variation of the live run took: satisfying the floor rather
      // than aiming at the goal. Every other rule is satisfied.
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          variation([segA(0, 4), segB(0, 4), segA(5, 8), segB(5, 7.2)], HOOK_ONE),
          validVariationTwo(),
        ])
      );

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      if (!result.success) expect(result.error).toContain('misses the 15s target length');
      expect(promptTextOfCall(1)).toContain('must total between 13.5s and 17.25s');

      const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
      expect(saved).toHaveLength(0);
    });

    it('asks the model for a tighter window than it enforces', async () => {
      mockGenerateContent.mockResolvedValue(validResponse());

      await planJob(jobId);

      const prompt = promptTextOfCall(0);
      expect(prompt).toContain('AIM FOR 15 SECONDS');
      // The stated aim is +-5%; the validator accepts -10%/+15%.
      expect(prompt).toContain('should land between 14.25s and 15.75s');
      expect(prompt).toContain('below 13.5s or above 17.25s is rejected outright');
      expect(prompt).toContain('do not aim for 13.5s');
    });
  });

  describe('structural distinctness between variations', () => {
    it('rejects two variations that open on the same footage', async () => {
      // Different cuts after the first, but the viewer meets both videos with
      // the same shot - the one difference that is always noticed.
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          validVariationOne(),
          variation([segA(0, 4), segB(2, 6), segA(4.5, 8), segB(6.5, 10)], HOOK_TWO),
        ])
      );

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      if (!result.success) expect(result.error).toContain('opens on the same footage');
      expect(promptTextOfCall(1)).toContain('start this one on a different moment');
    });

    it('rejects a variation that differs from its neighbour in only one position', async () => {
      // Variations 4 and 5 of the live run: same skeleton, one substituted clip
      // and a new hook. The opening differs, so only the sequence rule can
      // catch this.
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          validVariationOne(),
          variation([segB(2, 6), segB(0, 4), segA(4, 8), segB(4, 8)], HOOK_TWO),
        ])
      );

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('the same edit as variation 1');
      expect(promptTextOfCall(1)).toContain('at least two positions must differ');
    });

    it('accepts a variation that differs in two positions', async () => {
      // Deliberately not stricter than that: on a two-clip pool, demanding more
      // than "a different opening and one more change" would be retry churn.
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          validVariationOne(),
          variation([segB(2, 6), segB(0, 4), segA(4, 8), segA(0, 4)], HOOK_TWO),
        ])
      );

      const result = await planJob(jobId);

      expect(result).toEqual({ success: true, variationCount: 2, warning: null });
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('does not apply the rule to a pool too small to offer a second opening', async () => {
      // A single 3s clip cannot yield two distinct band-length cuts, so
      // demanding distinct openings would make the job unsatisfiable. Two
      // identical variations are the best this pool can do.
      const tinyJob = await createJob({
        creatorId,
        productName: 'Cozy Hoodie',
        sizingOverlayEnabled: false,
        lengthSeconds: 15,
        pacing: 'slow',
        variationCount: 2,
        clips: [{ storageKey: 'clips/tiny-two.mp4', originalFilename: 'tiny-two.mp4' }],
      });
      const [clip] = await db.select().from(rawClips).where(eq(rawClips.jobId, tinyJob.id));
      await db.insert(segments).values([
        { rawClipId: clip.id, startSeconds: '0', endSeconds: '3', contentTag: 'whole-clip', qualityTag: 'high' },
      ]);
      const onlyCut = { rawClipId: clip.id, startSeconds: 0, endSeconds: 3 };
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          { segments: [onlyCut], hookText: HOOK_ONE, sizingOverlayText: null, sizingOverlayPlacement: null },
          { segments: [onlyCut], hookText: HOOK_TWO, sizingOverlayText: null, sizingOverlayPlacement: null },
        ])
      );

      const result = await planJob(tinyJob.id);

      expect(result.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('tells the model the variations must be different edits', async () => {
      mockGenerateContent.mockResolvedValue(validResponse());

      await planJob(jobId);

      const prompt = promptTextOfCall(0);
      expect(prompt).toContain('THE 2 VARIATIONS MUST BE STRUCTURALLY DIFFERENT EDITS');
      expect(prompt).toContain('a different OPENING shot');
      expect(prompt).toContain('different SUBDIVISION BOUNDARIES');
      expect(prompt).toContain('match in every position but one will be rejected');
    });

    it('says nothing about distinctness when only one variation was asked for', async () => {
      const overlayJob = await createOverlayJob({ sizeWorn: 'M' });
      mockGenerateContent.mockResolvedValue(overlayResponse(overlayJob.clipId, 'For reference'));

      await planJob(overlayJob.id);

      expect(promptTextOfCall(0)).not.toContain('STRUCTURALLY DIFFERENT EDITS');
    });
  });

  describe('subdividing one long segment', () => {
    // A single 20s tagged segment against a 30s medium job. Before subdivision
    // was asked for, the pool measured one unrepeatable segment worth 20s and
    // the short-footage fallback fired; split into cuts it comfortably covers
    // the target twice over.
    let longJobId: string;
    let longClipId: string;

    beforeEach(async () => {
      const longJob = await createJob({
        creatorId,
        productName: 'Cozy Hoodie',
        sizingOverlayEnabled: false,
        lengthSeconds: 30,
        pacing: 'medium',
        variationCount: 1,
        clips: [{ storageKey: 'clips/long.mp4', originalFilename: 'long.mp4' }],
      });
      longJobId = longJob.id;
      const [clip] = await db.select().from(rawClips).where(eq(rawClips.jobId, longJobId));
      longClipId = clip.id;
      await db.insert(segments).values([
        { rawClipId: longClipId, startSeconds: '0', endSeconds: '20', contentTag: 'whole-clip', qualityTag: 'high' },
      ]);
    });

    it('accepts one long segment split into many short cuts', async () => {
      // Four cuts spaced 1.5s apart down the clip, then the same four again:
      // 31s from a single tagged segment, with no moment shown more than twice
      // and a second of footage thrown away at every splice.
      const cuts = [
        [0, 4],
        [5.5, 9.5],
        [11, 15],
        [16.5, 20],
        [0, 4],
        [5.5, 9.5],
        [11, 15],
        [16.5, 20],
      ];
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          {
            segments: cuts.map(([startSeconds, endSeconds]) => ({
              rawClipId: longClipId,
              startSeconds,
              endSeconds,
            })),
            hookText: HOOK_ONE,
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
        ])
      );

      const result = await planJob(longJobId);

      // No short-footage warning: subdivision makes the target genuinely
      // reachable, so the fallback must not fire.
      expect(result).toEqual({ success: true, variationCount: 1, warning: null });
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      const [row] = await db.select().from(jobs).where(eq(jobs.id, longJobId));
      expect(row.warning).toBeNull();
      expect(promptTextOfCall(0)).toContain('AIM FOR 30 SECONDS');
    });

    it('still rejects using that segment as one long take', async () => {
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          {
            segments: [
              { rawClipId: longClipId, startSeconds: 0, endSeconds: 20 },
              { rawClipId: longClipId, startSeconds: 0, endSeconds: 12 },
            ],
            hookText: HOOK_ONE,
            sizingOverlayText: null,
            sizingOverlayPlacement: null,
          },
        ])
      );

      const result = await planJob(longJobId);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('pacing');
      const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, longJobId));
      expect(saved).toHaveLength(0);
    });
  });

  describe('transient Gemini failures', () => {
    /** The 503 that the live run hit; see tests/lib/pipeline/retry.test.ts. */
    function highDemand503() {
      return Object.assign(new Error('503 high demand, please try again later'), { status: 503 });
    }

    const invalidResponse = { text: 'not valid json' };

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('retries a transient failure without turning it into a correction note', async () => {
      mockGenerateContent
        .mockRejectedValueOnce(highDemand503())
        .mockResolvedValueOnce(invalidResponse)
        .mockResolvedValueOnce(validResponse());

      const result = await planJob(jobId);

      expect(result).toEqual({ success: true, variationCount: 2, warning: null });
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      // The call replacing the 503 asks the same question again: the model never
      // answered, so there is nothing for it to correct.
      expect(promptTextOfCall(1)).not.toContain('previous response was invalid');
      // The call after the genuinely invalid answer does carry the correction.
      expect(promptTextOfCall(2)).toContain('previous response was invalid');
    });

    it('does not let a transient failure consume a validation attempt', async () => {
      mockGenerateContent
        .mockRejectedValueOnce(highDemand503())
        .mockResolvedValue(invalidResponse);

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      // 1 transient retry + the full 3-attempt validation budget.
      expect(mockGenerateContent).toHaveBeenCalledTimes(4);
      if (!result.success) expect(result.error).toContain('after 3 attempts');
    });

    it('fails with an error saying it was retried when the outage does not clear', async () => {
      mockGenerateContent.mockRejectedValue(highDemand503());

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      if (!result.success) {
        expect(result.error).toContain('still failed after 3 attempts');
        expect(result.error).toContain('high demand');
      }
    });

    it('does not retry a terminal 404 model-not-found failure', async () => {
      mockGenerateContent.mockRejectedValue(
        Object.assign(new Error('models/gemini-nope is not found'), { status: 404 })
      );

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      if (!result.success) expect(result.error).toContain('is not found');
    });
  });
});
