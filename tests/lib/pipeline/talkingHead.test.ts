import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { copyFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { eq } from 'drizzle-orm';

/**
 * Storage and transcription are mocked; everything between them runs for real.
 *
 * `tests/setup.ts` forces fake R2 credentials, so there is no path to a real
 * bucket — and transcription is the one step that costs money per call, which
 * a test suite must never do. What this file actually proves is the
 * orchestration: measure the audio, cut to the speech, keep it in sync, burn
 * the captions, record the result. All of that runs against a locally built
 * fixture.
 */
const { mockDownload, mockUpload, mockUploadThumbnail, mockTranscribe } = vi.hoisted(() => ({
  mockDownload: vi.fn(),
  mockUpload: vi.fn(),
  mockUploadThumbnail: vi.fn(),
  mockTranscribe: vi.fn(),
}));

vi.mock('@/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage')>();
  return {
    ...actual,
    downloadClipToTempFile: mockDownload,
    uploadRenderedVideo: mockUpload,
    uploadRenderThumbnail: mockUploadThumbnail,
  };
});

vi.mock('@/lib/pipeline/transcribe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pipeline/transcribe')>();
  return { ...actual, transcribeClip: mockTranscribe };
});

import { db } from '@/db/client';
import { jobs, rawClips, renders } from '@/db/schema';
import { createCreatorIfNotExists } from '@/db/repositories/creators';
import { createJob } from '@/db/repositories/jobs';
import { renderTalkingJob } from '@/lib/pipeline/talkingHead';
import { probeHasAudio, probeMedia, runFfmpeg } from '@/lib/render/ffmpeg';
import { WIDTH, HEIGHT } from '@/lib/render/frame';
import { cleanUpJobsForClerkId } from '../../helpers/db-cleanup';

const CLERK_ID = 'test_clerk_user_talking_head';

describe('renderTalkingJob', () => {
  let dir: string;
  let creatorId: string;
  let speechClip: string;
  let silentClip: string;
  let uploadedCopy: string | null = null;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'talkingjob-'));

    // Vertical video with tone bursts where "speech" is, silence between. The
    // detector cannot tell a tone from a voice, and using one makes the
    // expected cut points exact numbers this test chose.
    speechClip = path.join(dir, 'speech.mp4');
    const built = await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30:duration=9',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9',
      '-filter_complex',
      "[1:a]volume='if(between(t,0,2)+between(t,5,7),1,0)':eval=frame[a]",
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', speechClip,
    ]);
    expect(built).toEqual({ success: true });

    silentClip = path.join(dir, 'silent.mp4');
    const quiet = await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30:duration=5',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', silentClip,
    ]);
    expect(quiet).toEqual({ success: true });

    creatorId = (await createCreatorIfNotExists(CLERK_ID)).id;
  }, 180_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    uploadedCopy = null;
    /*
     * Copies the file aside before returning.
     *
     * The orchestrator deletes its working directory as soon as it is done, so
     * anything the test wants to inspect has to be taken during the upload —
     * which is also the last moment the real code has the finished file.
     */
    mockUpload.mockImplementation(async (localPath: string) => {
      uploadedCopy = path.join(dir, `uploaded-${Date.now()}.mp4`);
      await copyFile(localPath, uploadedCopy);
      return { success: true };
    });
    mockUploadThumbnail.mockResolvedValue({ success: true });
    mockTranscribe.mockResolvedValue({
      success: true,
      transcript: {
        text: 'hello everyone this is the product I have been using all week',
        words: 'hello everyone this is the product I have been using all week'.split(' '),
      },
    });
    await cleanUpJobsForClerkId(CLERK_ID);
  });

  afterAll(async () => {
    await cleanUpJobsForClerkId(CLERK_ID);
    await rm(dir, { recursive: true, force: true });
  });

  async function seedJob(clipPath: string) {
    const job = await createJob({
      creatorId,
      productName: 'talking test',
      sizingOverlayEnabled: false,
      lengthSeconds: 30,
      pacing: 'medium',
      variationCount: 1,
      kind: 'talking',
      clips: [{ storageKey: 'clips/fake.mp4', originalFilename: 'take.mp4' }],
    });
    mockDownload.mockResolvedValue({
      path: clipPath,
      contentType: 'video/mp4',
      // The orchestrator owns cleanup of what it downloads; the fixture is
      // shared across tests, so this must not actually delete it.
      cleanUp: async () => {},
    });
    return job;
  }

  it('cuts to the speech, keeps the audio and uploads one video', async () => {
    const job = await seedJob(speechClip);
    const result = await renderTalkingJob(job.id);

    expect(result).toMatchObject({ success: true });
    if (!result.success) return;

    // Four seconds of tone in a nine-second recording, so the pauses go.
    expect(result.durationSeconds).toBeGreaterThan(3.3);
    expect(result.durationSeconds).toBeLessThan(5.2);
    expect(result.removedSeconds).toBeGreaterThan(3);

    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(uploadedCopy).not.toBeNull();
    expect(await probeHasAudio(uploadedCopy!)).toBe(true);
    const media = await probeMedia(uploadedCopy!);
    expect(media.video).toMatchObject({ width: WIDTH, height: HEIGHT });
  }, 300_000);

  it('costs no AI call at all, because the cuts come from the audio', async () => {
    /*
     * With captions off there is nothing to transcribe: every cut is decided by
     * measuring loudness, which is free. This is the whole cost story for
     * talking mode, so it is asserted rather than assumed — a stray call here
     * would bill every creator on every re-render without anyone noticing.
     */
    const job = await seedJob(speechClip);
    const result = await renderTalkingJob(job.id);

    expect(result).toMatchObject({ success: true });
    expect(mockTranscribe).not.toHaveBeenCalled();

    // And re-rendering stays free.
    await renderTalkingJob(job.id);
    expect(mockTranscribe).not.toHaveBeenCalled();
  }, 300_000);

  it('refuses a recording with no speech before it costs an API call', async () => {
    const job = await seedJob(silentClip);
    const result = await renderTalkingJob(job.id);

    expect(result).toMatchObject({ success: false });
    if (result.success) return;
    expect(result.error).toMatch(/no speech/i);
    // The order matters: measuring is free, transcription is not.
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  }, 180_000);

  it('reports a job with no recording rather than throwing', async () => {
    const job = await createJob({
      creatorId,
      productName: 'no clips',
      sizingOverlayEnabled: false,
      lengthSeconds: 30,
      pacing: 'medium',
      variationCount: 1,
      kind: 'talking',
      clips: [],
    });
    await db.delete(rawClips).where(eq(rawClips.jobId, job.id));

    const result = await renderTalkingJob(job.id);
    expect(result).toEqual({ success: false, error: 'This job has no recording to edit.' });
  }, 60_000);

  it('leaves no renders row behind of its own accord', async () => {
    // The worker owns the renders row; this function only produces the file and
    // the storage key, so a stray row here would double-count in the UI.
    const job = await seedJob(speechClip);
    await renderTalkingJob(job.id);
    const rows = await db.select().from(renders).where(eq(renders.jobId, job.id));
    expect(rows).toHaveLength(0);
  }, 300_000);
});
