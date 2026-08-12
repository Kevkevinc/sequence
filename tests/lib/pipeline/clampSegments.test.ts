import { describe, it, expect } from 'vitest';
import { clampSegmentsToClip } from '@/lib/pipeline/tagging';

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
