import { describe, it, expect } from 'vitest';
import { dedupeIdenticalCuts } from '@/lib/pipeline/director';

const CLIP = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function cut(rawClipId: string, startSeconds: number, endSeconds: number) {
  return { rawClipId, startSeconds, endSeconds };
}

/** Every (clip, start, end) triple in the plan, as the validator would key them. */
function keys(variations: Array<{ segments: Array<ReturnType<typeof cut>> }>): string[] {
  return variations.flatMap((v) =>
    v.segments.map((s) => `${s.rawClipId}|${s.startSeconds}|${s.endSeconds}`)
  );
}

/**
 * The shape the live failures actually had: variations that are genuinely
 * different edits which happen to collide on one cut. A pair of one-cut
 * variations holding the same cut is not this — it is two identical videos,
 * which the repair deliberately refuses to touch (see the last block).
 */
function collidingPlan(count: number, shared: ReturnType<typeof cut>) {
  return Array.from({ length: count }, (_, index) => ({
    segments: [shared ? { ...shared } : cut(CLIP, 0, 1), cut(CLIP, 10 + index * 2, 12 + index * 2)],
  }));
}

describe('dedupeIdenticalCuts', () => {
  it('leaves a plan with no repeats completely alone', () => {
    const variations = [
      { segments: [cut(CLIP, 0, 2), cut(CLIP, 4, 6)] },
      { segments: [cut(CLIP, 8, 10)] },
    ];
    const before = JSON.stringify(variations);
    dedupeIdenticalCuts(variations, new Map([[CLIP, 30]]));
    expect(JSON.stringify(variations)).toBe(before);
  });

  it('shifts a cut shared by two otherwise-different variations', () => {
    const variations = collidingPlan(2, cut(CLIP, 0.2, 1.7));
    dedupeIdenticalCuts(variations, new Map([[CLIP, 30]]));

    const all = keys(variations);
    expect(new Set(all).size).toBe(all.length);
    // The first use is the anchor and must not move.
    expect(variations[0].segments[0]).toEqual(cut(CLIP, 0.2, 1.7));
  });

  it('preserves each cut’s duration exactly, so pacing and total length are untouched', () => {
    const variations = collidingPlan(3, cut(CLIP, 1, 3.5));
    dedupeIdenticalCuts(variations, new Map([[CLIP, 40]]));

    for (const variation of variations) {
      expect(variation.segments[0].endSeconds - variation.segments[0].startSeconds).toBeCloseTo(2.5, 6);
    }
    const all = keys(variations);
    expect(new Set(all).size).toBe(all.length);
  });

  it('never moves a cut outside its own clip', () => {
    // The shared cut ends on the last frame of footage, so it can only move
    // earlier — never past the end, which would render as a failed cut.
    const variations = [
      { segments: [cut(CLIP, 8, 10), cut(CLIP, 0, 2)] },
      { segments: [cut(CLIP, 8, 10), cut(CLIP, 3, 5)] },
    ];
    dedupeIdenticalCuts(variations, new Map([[CLIP, 10]]));

    for (const variation of variations) {
      for (const segment of variation.segments) {
        expect(segment.startSeconds).toBeGreaterThanOrEqual(0);
        expect(segment.endSeconds).toBeLessThanOrEqual(10);
      }
    }
    const all = keys(variations);
    expect(new Set(all).size).toBe(all.length);
  });

  it('leaves a cut alone when its clip has no room to move it', () => {
    // Footage exactly as long as the shared cut: every shift leaves the clip,
    // so the repair must decline and let the validator reject in the normal way
    // rather than emit a cut running past the end of the video.
    const variations = [
      { segments: [cut(CLIP, 0, 10), cut(OTHER, 0, 2)] },
      { segments: [cut(CLIP, 0, 10), cut(OTHER, 4, 6)] },
    ];
    dedupeIdenticalCuts(variations, new Map([[CLIP, 10], [OTHER, 30]]));
    expect(variations[1].segments[0]).toEqual(cut(CLIP, 0, 10));
  });

  it('treats the same timestamps on different clips as already distinct', () => {
    const variations = [
      { segments: [cut(CLIP, 0, 2), cut(CLIP, 6, 8)] },
      { segments: [cut(OTHER, 0, 2), cut(CLIP, 9, 11)] },
    ];
    dedupeIdenticalCuts(variations, new Map([[CLIP, 30], [OTHER, 30]]));
    expect(variations[1].segments[0]).toEqual(cut(OTHER, 0, 2));
  });

  it('does not touch a cut reused inside one variation', () => {
    // Reuse within a variation is governed by the separate reuse cap; moving it
    // here would silently change an edit the model deliberately built.
    const variations = [
      { segments: [cut(CLIP, 0, 2), cut(CLIP, 0, 2)] },
      { segments: [cut(CLIP, 9, 11)] },
    ];
    dedupeIdenticalCuts(variations, new Map([[CLIP, 30]]));
    expect(variations[0].segments[1]).toEqual(cut(CLIP, 0, 2));
  });

  it('resolves a ten-variation collision, which is the case that broke live jobs', () => {
    // "variations.5.segments.1 is byte-identical to one in variation 2", ten
    // times over, is what three real jobs died on after burning three model
    // calls each.
    const variations = collidingPlan(10, cut(CLIP, 0.2, 1.7));
    dedupeIdenticalCuts(variations, new Map([[CLIP, 40]]));

    const all = keys(variations);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('dedupeIdenticalCuts and wholesale duplicates', () => {
  it('refuses to repair a variation that is a straight copy of another', () => {
    // Nudging each cut by a tenth of a second would satisfy the frame-identity
    // rule while still handing the creator two videos they cannot tell apart.
    // That has to stay a rejection, so the model produces a real second edit.
    const variations = [
      { segments: [cut(CLIP, 0, 2), cut(CLIP, 4, 6)] },
      { segments: [cut(CLIP, 0, 2), cut(CLIP, 4, 6)] },
    ];
    const before = JSON.stringify(variations);
    dedupeIdenticalCuts(variations, new Map([[CLIP, 30]]));
    expect(JSON.stringify(variations)).toBe(before);
  });

  it('treats two single-cut variations on the same cut as a duplicate, not a collision', () => {
    const variations = [{ segments: [cut(CLIP, 0, 2)] }, { segments: [cut(CLIP, 0, 2)] }];
    const before = JSON.stringify(variations);
    dedupeIdenticalCuts(variations, new Map([[CLIP, 30]]));
    expect(JSON.stringify(variations)).toBe(before);
  });

  it('still repairs when the variations genuinely differ but share one cut', () => {
    const variations = [
      { segments: [cut(CLIP, 0, 2), cut(CLIP, 4, 6)] },
      { segments: [cut(CLIP, 0, 2), cut(CLIP, 10, 12)] },
    ];
    dedupeIdenticalCuts(variations, new Map([[CLIP, 30]]));

    const all = keys(variations);
    expect(new Set(all).size).toBe(all.length);
    expect(variations[1].segments[1]).toEqual(cut(CLIP, 10, 12));
  });
});

describe('dedupeIdenticalCuts under crowding', () => {
  it('still repairs other variations when one of them is a wholesale copy', () => {
    // The live regression: an earlier version abandoned the whole pass as soon
    // as any duplicate pair existed, so a plan containing both a copied
    // variation and an ordinary collision had neither repaired — and the job
    // failed a second time on the collision the repair exists to absorb.
    const variations = [
      { segments: [cut(CLIP, 0.2, 1.6), cut(CLIP, 5, 7)] },
      { segments: [cut(CLIP, 0.2, 1.6), cut(CLIP, 5, 7)] }, // wholesale copy of #1
      { segments: [cut(CLIP, 0.2, 1.6), cut(CLIP, 12, 14)] }, // ordinary collision
    ];
    dedupeIdenticalCuts(variations, new Map([[CLIP, 40]]));

    // The copy is left for the validator to reject...
    expect(variations[1].segments).toEqual([cut(CLIP, 0.2, 1.6), cut(CLIP, 5, 7)]);
    // ...but the genuine third variation no longer shares frames with the first.
    expect(variations[2].segments[0]).not.toEqual(cut(CLIP, 0.2, 1.6));
    expect(
      variations[2].segments[0].endSeconds - variations[2].segments[0].startSeconds
    ).toBeCloseTo(1.4, 6);
  });

  it('places every variation when ten of them pile onto one popular moment', () => {
    // 31 tagged segments feeding 10 variations is what the failing job actually
    // had, so the same cut gets picked over and over and the search has to
    // reach past its immediate neighbours.
    const variations = Array.from({ length: 10 }, (_, index) => ({
      segments: [cut(CLIP, 0.2, 1.6), cut(CLIP, 20 + index, 22 + index)],
    }));
    dedupeIdenticalCuts(variations, new Map([[CLIP, 40]]));

    const openings = variations.map((v) => `${v.segments[0].startSeconds}-${v.segments[0].endSeconds}`);
    expect(new Set(openings).size).toBe(10);
    for (const v of variations) {
      expect(v.segments[0].endSeconds - v.segments[0].startSeconds).toBeCloseTo(1.4, 6);
      expect(v.segments[0].startSeconds).toBeGreaterThanOrEqual(0);
      expect(v.segments[0].endSeconds).toBeLessThanOrEqual(40);
    }
  });
});
