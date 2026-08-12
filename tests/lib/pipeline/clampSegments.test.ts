import { describe, it, expect } from 'vitest';
import { clampSegmentsToClip, clampSegmentsToWindow, usableWindowOf } from '@/lib/pipeline/tagging';

const seg = (startSeconds: number, endSeconds: number) => ({ startSeconds, endSeconds });

describe('clampSegmentsToClip', () => {
  it('keeps segments that fit', () => {
    const { kept, droppedCount, trimmedCount } = clampSegmentsToClip([seg(0, 4), seg(10, 20)], 77);
    expect(kept).toEqual([seg(0, 4), seg(10, 20)]);
    expect(droppedCount).toBe(0);
    expect(trimmedCount).toBe(0);
  });

  it('drops a segment that starts past the end of the clip', () => {
    /*
     * The real failure. On a 77.1s clip the tagger returned segments out to
     * 117s, the director planned cuts inside them, and four of ten variations
     * died at render with "cut starts at 110s, past the end of 77.1s of
     * picture". The creator got six videos and no explanation.
     */
    const { kept, droppedCount } = clampSegmentsToClip([seg(0, 4), seg(104, 110), seg(110, 117)], 77.1);
    expect(kept).toEqual([seg(0, 4)]);
    expect(droppedCount).toBe(2);
  });

  it('trims a segment that merely overruns the end', () => {
    const { kept, trimmedCount } = clampSegmentsToClip([seg(70, 90)], 77.1);
    expect(kept).toEqual([seg(70, 77.1)]);
    expect(trimmedCount).toBe(1);
  });

  it('drops an overrun that leaves too little to cut from', () => {
    // Trimming this to 0.1s would keep a segment no cut can be taken from,
    // which fails later instead of here.
    const { kept, droppedCount } = clampSegmentsToClip([seg(77, 90)], 77.1);
    expect(kept).toEqual([]);
    expect(droppedCount).toBe(1);
  });

  it('keeps a segment ending exactly on the last frame', () => {
    expect(clampSegmentsToClip([seg(70, 77.1)], 77.1).kept).toEqual([seg(70, 77.1)]);
  });

  it('reports everything dropped rather than silently emptying', () => {
    const { kept, droppedCount } = clampSegmentsToClip([seg(100, 110)], 77.1);
    expect(kept).toEqual([]);
    expect(droppedCount).toBe(1);
  });
});

describe('usableWindowOf', () => {
  it('leaves a clip alone when the tagger reports no camera handling', () => {
    // The behaviour every clip had before this existed, and the behaviour of
    // any clip that genuinely opens and closes on usable footage.
    expect(usableWindowOf({ usableStartSeconds: 0, usableEndSeconds: 30 }, 30)).toEqual({
      startSeconds: 0,
      endSeconds: 30,
    });
  });

  it('leaves a clip alone when the tagger says nothing at all', () => {
    // An older model, a drifted response, or the bare-array form: none of them
    // carry a window, and none of them should change what the clip yields.
    expect(usableWindowOf({}, 30)).toEqual({ startSeconds: 0, endSeconds: 30 });
  });

  it('trims the reach for the record button and the walk back to stop it', () => {
    expect(usableWindowOf({ usableStartSeconds: 1.5, usableEndSeconds: 27.2 }, 30)).toEqual({
      startSeconds: 1.5,
      endSeconds: 27.2,
    });
  });

  it('will not let a wrong answer eat the clip', () => {
    /*
     * The model is being asked to judge something it can get badly wrong, so
     * what it can cost is capped rather than trusted. Three seconds at each end
     * is far more than a phone reach and far less than a product demo.
     */
    const window = usableWindowOf({ usableStartSeconds: 12, usableEndSeconds: 14 }, 30);
    expect(window.startSeconds).toBe(3);
    expect(window.endSeconds).toBe(27);
  });

  it('keeps the whole clip rather than trimming it to a stub', () => {
    // Below the minimum clip length there is nothing left to cut two ways,
    // which is the only reason the clip is here.
    expect(usableWindowOf({ usableStartSeconds: 2, usableEndSeconds: 3 }, 4)).toEqual({
      startSeconds: 0,
      endSeconds: 4,
    });
  });

  it('ignores a window that runs past the footage', () => {
    expect(usableWindowOf({ usableStartSeconds: 0, usableEndSeconds: 90 }, 30).endSeconds).toBe(30);
  });
});

describe('clampSegmentsToWindow', () => {
  const segments = [
    { startSeconds: 0, endSeconds: 30, label: 'whole-clip' },
    { startSeconds: 0.2, endSeconds: 1.0, label: 'the reach' },
    { startSeconds: 4, endSeconds: 8, label: 'good' },
    { startSeconds: 27.5, endSeconds: 30, label: 'the walk-up' },
  ];

  it('drops what sits entirely in the camera handling', () => {
    const { kept } = clampSegmentsToWindow(segments, 1.5, 27.2);
    expect(kept.map((s) => s.label)).toEqual(['whole-clip', 'good']);
  });

  it('pulls the whole-clip segment inside the window rather than dropping it', () => {
    // This is the segment that was handing the director the reach and the
    // walk-up regardless of how anything was tagged, and it is also the
    // fallback the planner leans on, so it has to survive — trimmed, not lost.
    const { kept, trimmedCount } = clampSegmentsToWindow(segments, 1.5, 27.2);
    expect(kept[0]).toMatchObject({ startSeconds: 1.5, endSeconds: 27.2, label: 'whole-clip' });
    expect(trimmedCount).toBe(1);
  });

  it('drops what is left too short to cut', () => {
    const { kept, droppedCount } = clampSegmentsToWindow(
      [{ startSeconds: 1.2, endSeconds: 1.7 }],
      1.5,
      27.2
    );
    expect(kept).toEqual([]);
    expect(droppedCount).toBe(1);
  });
});
