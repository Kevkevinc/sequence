import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { eq } from 'drizzle-orm';
import { runFfmpeg } from '@/lib/render/ffmpeg';

/**
 * `downloadClipToTempFile`/`uploadRenderedVideo` are mocked rather than hitting
 * real R2. `tests/setup.ts` deliberately forces fake `R2_*` credentials for
 * every test — a documented guard after an earlier incident where a real
 * secret nearly leaked into a test file — so there is no credentialed path to
 * a real bucket here, and there should not be. What this test actually needs
 * to prove — that the ffmpeg orchestration (normalise → concat → overlay)
 * produces a correct file from a real EditPlan — does not require R2 at all:
 * the mocks stand in for storage, and every render step in between runs for
 * real against locally-generated fixtures, exactly like Tasks 2 and 3.
 */
const { mockDownload, mockUpload } = vi.hoisted(() => ({
  mockDownload: vi.fn(),
  mockUpload: vi.fn(),
}));

vi.mock('@/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage')>();
  return {
    ...actual,
    downloadClipToTempFile: mockDownload,
    uploadRenderedVideo: mockUpload,
  };
});

import { db } from '@/db/client';
import { rawClips, editPlans } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { renderPlan } from '@/lib/render/renderPlan';
import { probeDuration, probeMedia } from '@/lib/render/ffmpeg';

describe('renderPlan', () => {
  const CLERK_ID = 'test_clerk_user_render_plan';
  let fixturesDir: string;
  let clipAPath: string;
  let clipBPath: string;
  let creatorId: string;
  let jobId: string;
  let clipAId: string;
  let clipBId: string;
  /**
   * `renderPlan` deletes its whole temp directory — including the finished
   * video — right after the (mocked) upload returns, exactly as it should.
   * So the file itself cannot be inspected after `renderPlan` resolves; the
   * mock measures it while it still exists, on the way past.
   */
  let uploadedVideoProperties: { width: number; height: number; durationSeconds: number }[];

  beforeAll(async () => {
    fixturesDir = await mkdtemp(path.join(tmpdir(), 'ugc-renderplan-fixtures-'));
    clipAPath = path.join(fixturesDir, 'a.mp4');
    clipBPath = path.join(fixturesDir, 'b.mp4');

    // Two short, distinct-looking source clips, well within any pacing band.
    const madeA = await runFfmpeg([
      '-f', 'lavfi', '-i', 'color=c=red:size=640x480:rate=30:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=5',
      '-c:v', 'libx264', '-c:a', 'aac', '-shortest', clipAPath,
    ]);
    const madeB = await runFfmpeg([
      '-f', 'lavfi', '-i', 'color=c=blue:size=640x480:rate=30:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=600:duration=5',
      '-c:v', 'libx264', '-c:a', 'aac', '-shortest', clipBPath,
    ]);
    expect(madeA.success).toBe(true);
    expect(madeB.success).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await rm(fixturesDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    uploadedVideoProperties = [];

    mockDownload.mockImplementation(async (storageKey: string) => {
      const path_ = storageKey === 'clips/a.mp4' ? clipAPath : clipBPath;
      return { path: path_, contentType: 'video/mp4', cleanUp: vi.fn(async () => {}) };
    });
    mockUpload.mockImplementation(async (localPath: string) => {
      const media = await probeMedia(localPath);
      uploadedVideoProperties.push({
        width: media.video?.width ?? 0,
        height: media.video?.height ?? 0,
        durationSeconds: await probeDuration(localPath),
      });
      return { success: true };
    });

    const creator = await createCreatorIfNotExists(CLERK_ID);
    creatorId = creator.id;

    const job = await createJob({
      creatorId,
      productName: 'Render Plan Test Product',
      sizingOverlayEnabled: true,
      lengthSeconds: 15,
      pacing: 'medium',
      variationCount: 1,
      clips: [
        { storageKey: 'clips/a.mp4', originalFilename: 'a.mp4' },
        { storageKey: 'clips/b.mp4', originalFilename: 'b.mp4' },
      ],
    });
    jobId = job.id;

    const clips = await db.select().from(rawClips).where(eq(rawClips.jobId, jobId));
    clipAId = clips.find((c) => c.storageKey === 'clips/a.mp4')!.id;
    clipBId = clips.find((c) => c.storageKey === 'clips/b.mp4')!.id;

    await db.delete(editPlans).where(eq(editPlans.jobId, jobId));
  });

  it('renders a full edit plan: downloads once per clip, cuts, joins, overlays text, and uploads', async () => {
    const [plan] = await db
      .insert(editPlans)
      .values({
        jobId,
        variationNumber: 1,
        segments: [
          { rawClipId: clipAId, startSeconds: 0, endSeconds: 4 },
          { rawClipId: clipBId, startSeconds: 0, endSeconds: 4 },
          { rawClipId: clipAId, startSeconds: 1, endSeconds: 5 },
        ],
        hookText: "POV: it's the render plan test",
        sizingOverlayText: 'Fit check — size L',
        sizingOverlayPlacement: 'bottom-left',
      })
      .returning();

    const result = await renderPlan(plan.id);

    expect(result).toEqual({
      success: true,
      storageKey: expect.stringMatching(/^renders\/.+\.mp4$/),
      durationSeconds: expect.any(Number),
    });

    // Distinct-clip-once: two segments reuse clip A, but it should only be
    // downloaded once, not three times.
    expect(mockDownload).toHaveBeenCalledTimes(2);

    // The file actually handed to "upload" is real and correct — measured
    // while it still existed, since renderPlan cleans it up right after.
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const rendered = uploadedVideoProperties[0];
    expect(rendered).toEqual({ width: 1080, height: 1920, durationSeconds: expect.any(Number) });

    const planned = 4 + 4 + 4; // three 4s cuts
    expect(rendered.durationSeconds).toBeGreaterThan(planned - 1);
    expect(rendered.durationSeconds).toBeLessThan(planned + 1);
    expect(result.success && result.durationSeconds).toBeCloseTo(rendered.durationSeconds, 1);
  }, 120_000);

  it('cleans up every temp file and downloaded clip, on success', async () => {
    const [plan] = await db
      .insert(editPlans)
      .values({
        jobId,
        variationNumber: 1,
        segments: [{ rawClipId: clipAId, startSeconds: 0, endSeconds: 3 }],
        hookText: 'Cleanup check',
        sizingOverlayText: null,
        sizingOverlayPlacement: null,
      })
      .returning();

    const before = await readdir(tmpdir());
    const result = await renderPlan(plan.id);
    expect(result.success).toBe(true);

    const cleanUpFns = mockDownload.mock.results.map((r) => r.value);
    for (const clip of await Promise.all(cleanUpFns)) {
      expect(clip.cleanUp).toHaveBeenCalledTimes(1);
    }

    const after = await readdir(tmpdir());
    const leaked = after.filter((f) => f.startsWith('ugc-render-') && !before.includes(f));
    expect(leaked).toEqual([]);
  }, 60_000);

  it('cleans up every temp file even when a cut fails', async () => {
    const [plan] = await db
      .insert(editPlans)
      .values({
        jobId,
        variationNumber: 1,
        // Starts past the end of a 5s source entirely: normaliseCut rejects
        // this outright, rather than clamping it the way a merely-long end
        // time would be.
        segments: [{ rawClipId: clipAId, startSeconds: 10, endSeconds: 15 }],
        hookText: 'Failure cleanup check',
        sizingOverlayText: null,
        sizingOverlayPlacement: null,
      })
      .returning();

    const before = await readdir(tmpdir());
    const result = await renderPlan(plan.id);

    expect(result.success).toBe(false);
    expect(mockUpload).not.toHaveBeenCalled();

    const after = await readdir(tmpdir());
    const leaked = after.filter((f) => f.startsWith('ugc-render-') && !before.includes(f));
    expect(leaked).toEqual([]);
  }, 60_000);

  it('downloads each distinct clip only once even when a plan cuts it many times', async () => {
    const [plan] = await db
      .insert(editPlans)
      .values({
        jobId,
        variationNumber: 1,
        segments: [
          { rawClipId: clipAId, startSeconds: 0, endSeconds: 3 },
          { rawClipId: clipAId, startSeconds: 1, endSeconds: 4 },
          { rawClipId: clipAId, startSeconds: 2, endSeconds: 5 },
        ],
        hookText: 'Reuse check',
        sizingOverlayText: null,
        sizingOverlayPlacement: null,
      })
      .returning();

    const result = await renderPlan(plan.id);

    expect(result.success).toBe(true);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(mockDownload).toHaveBeenCalledWith('clips/a.mp4');
  }, 60_000);

  it('returns a failure result instead of throwing when the edit plan does not exist', async () => {
    const result = await renderPlan('00000000-0000-0000-0000-000000000000');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('00000000-0000-0000-0000-000000000000');
    }
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('returns a failure result instead of throwing when a segment references a deleted clip', async () => {
    const [plan] = await db
      .insert(editPlans)
      .values({
        jobId,
        variationNumber: 1,
        segments: [{ rawClipId: '00000000-0000-0000-0000-000000000000', startSeconds: 0, endSeconds: 3 }],
        hookText: 'Missing clip check',
        sizingOverlayText: null,
        sizingOverlayPlacement: null,
      })
      .returning();

    const result = await renderPlan(plan.id);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('00000000-0000-0000-0000-000000000000');
    }
    expect(mockDownload).not.toHaveBeenCalled();
  });
});
