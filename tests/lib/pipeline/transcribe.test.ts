import { describe, it, expect } from 'vitest';
import { wordsOf } from '@/lib/pipeline/transcribe';

describe('wordsOf', () => {
  it('splits a transcript into ordered words', () => {
    expect(wordsOf('hello there everyone')).toEqual(['hello', 'there', 'everyone']);
  });

  it('collapses the whitespace a model tends to emit', () => {
    expect(wordsOf('  hello \n there\t\tworld  ')).toEqual(['hello', 'there', 'world']);
  });

  it('keeps filler words and punctuation attached to their word', () => {
    // The editor decides what to cut; it cannot cut an "um" that was tidied
    // away before it ever saw the transcript.
    expect(wordsOf("um, so I was like... yeah")).toEqual([
      'um,', 'so', 'I', 'was', 'like...', 'yeah',
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(wordsOf('')).toEqual([]);
    expect(wordsOf('   \n  ')).toEqual([]);
  });
});
