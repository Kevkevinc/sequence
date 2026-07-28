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
  // 16s and 15s, both within 15% of the job's 15s target.
  const validVariationOne = () => variation([segA(0, 8), segB(2, 6), segB(6, 10)], HOOK_ONE);
  const validVariationTwo = () => variation([segB(0, 10), segA(0, 5)], HOOK_TWO);
  const validResponse = () => geminiResponse([validVariationOne(), validVariationTwo()]);

  /** Creates a single-clip, single-variation job with the sizing overlay enabled. */
  async function createOverlayJob(options: { sizeWorn?: string; creatorId?: string }) {
    const overlayJob = await createJob({
      creatorId: options.creatorId ?? creatorId,
      productName: 'Cozy Hoodie',
      sizeWorn: options.sizeWorn,
      sizingOverlayEnabled: true,
      lengthSeconds: 15,
      pacing: 'fast',
      variationCount: 1,
      clips: [{ storageKey: 'clips/c.mp4', originalFilename: 'c.mp4' }],
    });
    const [clip] = await db.select().from(rawClips).where(eq(rawClips.jobId, overlayJob.id));
    await db.insert(segments).values([
      { rawClipId: clip.id, startSeconds: '0', endSeconds: '15', contentTag: 'whole-clip', qualityTag: 'high' },
    ]);
    return { id: overlayJob.id, clipId: clip.id };
  }

  /** A one-variation overlay response with the given model-authored lead-in. */
  function overlayResponse(clipId: string, sizingOverlayText: string | null, placement = 'bottom-center') {
    return geminiResponse([
      {
        segments: [{ rawClipId: clipId, startSeconds: 0, endSeconds: 15 }],
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
      endSeconds: 8,
    };
    mockGenerateContent.mockResolvedValue(
      geminiResponse([variation([foreign, segB(2, 6), segB(6, 10)], HOOK_ONE), validVariationTwo()])
    );

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    expect(promptTextOfCall(1)).toContain('previous response was invalid');
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(0);
  });

  it('rejects a variation reaching past the end of its clip footage', async () => {
    // Totals 17s, inside the duration tolerance, so only the overrun is at fault.
    mockGenerateContent.mockResolvedValue(
      geminiResponse([variation([segA(0, 8), segB(2, 6), segB(6, 11)], HOOK_ONE), validVariationTwo()])
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
        variation([segA(0, 8), segA(0, 8)], HOOK_ONE), // 16s: duration is fine, order is not
        validVariationTwo(),
      ])
    );

    const result = await planJob(jobId);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('consecutive');
    const saved = await db.select().from(editPlans).where(eq(editPlans.jobId, jobId));
    expect(saved).toHaveLength(0);
  });

  it('rejects a variation whose cuts do not sum to within 15% of the target length', async () => {
    // 8s against a 15s target: outside the 12.75s - 17.25s window.
    mockGenerateContent.mockResolvedValue(
      geminiResponse([variation([segA(0, 8)], HOOK_ONE), validVariationTwo()])
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

  it('accepts variations sitting exactly on the duration tolerance boundary', async () => {
    // 12.75s and 17.25s are the extremes of the allowed window for a 15s target.
    mockGenerateContent.mockResolvedValue(
      geminiResponse([
        variation([segA(0, 8), segB(2, 6), segB(6, 6.75)], HOOK_ONE),
        variation([segB(0, 10), segA(0, 7.25)], HOOK_TWO),
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
    const spacer = () => segA(0, 1); // 1s

    it('rejects a variation that uses the same segment three times', async () => {
      // 14s total and no back-to-back repeat: legal under every rule the first
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
      // 15s exactly: the cap is a cap, not a ban on reuse.
      const reusedTwice = variation([shortCut(), segA(0, 7), shortCut()], HOOK_ONE);
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
  });

  describe('when there is not enough footage to fill the target length', () => {
    // 7s of distinct footage against a 30s target: with the reuse cap the pool
    // can fill 14s at most, so the +-15% rule is unreachable. This is the shape
    // of the first live run, where 3 short clips got looped 12 times each.
    const CUT_ONE = { startSeconds: 0, endSeconds: 4 };
    const CUT_TWO = { startSeconds: 4, endSeconds: 7 };

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
      // 14s against a 30s target: nowhere near the +-15% band, but it is every
      // second the footage honestly has, which beats a padded 30s.
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
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          {
            segments: [{ rawClipId: extraClip.id, startSeconds: 0, endSeconds: 30 }],
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
      // 4s when 14s was achievable: the relaxed rule is "best achievable", not
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
      // 21s: closer to the 30s target than the honest 14s, and exactly the kind
      // of padding this whole path exists to prevent.
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
      expect(prompt).not.toContain('must sum to within 15%');
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
      mockGenerateContent.mockResolvedValue(
        geminiResponse([
          {
            segments: [
              { rawClipId: clip.id, startSeconds: 0, endSeconds: 10 },
              { rawClipId: clip.id, startSeconds: 2, endSeconds: 6 },
              { rawClipId: clip.id, startSeconds: 0, endSeconds: 10 },
            ],
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

    it('leaves the +-15% rule in force when the footage is sufficient', async () => {
      // The normal job's pool is ample, so the fallback must not apply to it.
      mockGenerateContent.mockResolvedValue(
        geminiResponse([variation([segA(0, 8)], HOOK_ONE), validVariationTwo()])
      );

      const result = await planJob(jobId);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('total duration');
      expect(promptTextOfCall(0)).toContain('must sum to within 15%');
      expect(await warningOf(jobId)).toBeNull();
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
