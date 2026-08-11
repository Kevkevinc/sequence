import { describe, it, expect } from 'vitest';
import { anchorBlock, blockWidth, layoutTextBlock, wrapText } from '@/lib/render/textLayout';

/** Every character is 10 wide, so expected line breaks are countable by hand. */
const measure = (text: string) => text.length * 10;

describe('wrapText', () => {
  it('breaks on spaces to fit the width', () => {
    expect(wrapText('aaa bbb ccc', 70, measure)).toEqual(['aaa bbb', 'ccc']);
  });

  it('keeps text on one line when it already fits', () => {
    expect(wrapText('aaa bbb', 200, measure)).toEqual(['aaa bbb']);
  });

  it('splits a word that is wider than the whole line', () => {
    // No space to break on. Running off both edges of the frame is not an
    // option, and there is no better break to find.
    expect(wrapText('aaaaaaaa', 30, measure)).toEqual(['aaa', 'aaa', 'aa']);
  });

  it('collapses whitespace and ignores empty input', () => {
    expect(wrapText('   ', 100, measure)).toEqual([]);
    expect(wrapText('a    b', 100, measure)).toEqual(['a b']);
  });

  it('honours explicit line breaks', () => {
    expect(wrapText('aa\nbb', 100, measure)).toEqual(['aa', 'bb']);
  });
});

describe('layoutTextBlock', () => {
  it('reports a height proportional to the number of lines', () => {
    const one = layoutTextBlock({ text: 'aaa', fontSize: 40, lineHeightRatio: 1.2, maxWidth: 100, measure });
    const two = layoutTextBlock({ text: 'aaa bbb', fontSize: 40, lineHeightRatio: 1.2, maxWidth: 40, measure });

    expect(one.lines).toHaveLength(1);
    expect(two.lines).toHaveLength(2);
    expect(two.blockHeight).toBe(two.lineHeight * 2);
    expect(two.blockHeight).toBeGreaterThan(one.blockHeight);
  });
});

describe('anchorBlock', () => {
  const frame = { frameWidth: 1000, frameHeight: 2000, marginPx: 20 };

  it('centres the block on the requested fraction when there is room', () => {
    const { x, top } = anchorBlock({
      ...frame, centreXFraction: 0.5, centreYFraction: 0.5, blockWidth: 200, blockHeight: 100,
    });
    expect(x).toBe(500);
    expect(top).toBe(950);
  });

  it('keeps a block dragged towards an edge fully inside the frame', () => {
    // A caption that is 80% visible reads as a bug rather than a choice, so the
    // block is pushed back in rather than the drag being refused.
    const left = anchorBlock({
      ...frame, centreXFraction: 0, centreYFraction: 0.5, blockWidth: 200, blockHeight: 100,
    });
    expect(left.x).toBe(120); // margin + half the block

    const bottom = anchorBlock({
      ...frame, centreXFraction: 0.5, centreYFraction: 1, blockWidth: 200, blockHeight: 100,
    });
    expect(bottom.top).toBe(1880); // frame - margin - height
  });

  it('centres rather than inverting when the block cannot fit the margins', () => {
    const { x, top } = anchorBlock({
      ...frame, centreXFraction: 0.5, centreYFraction: 0.5, blockWidth: 1200, blockHeight: 2400,
    });
    expect(x).toBe(500);
    expect(top).toBe(20);
  });
});

describe('blockWidth', () => {
  it('is the width of the widest line', () => {
    expect(blockWidth(['aa', 'aaaa', 'a'], measure)).toBe(40);
    expect(blockWidth([], measure)).toBe(0);
  });
});
