import { describe, it, expect } from 'vitest';
import { parseFirstJsonValue } from '@/lib/pipeline/json';

describe('parseFirstJsonValue', () => {
  it('parses an ordinary response unchanged', () => {
    expect(parseFirstJsonValue('{"variations":[1,2]}')).toEqual({ variations: [1, 2] });
    expect(parseFirstJsonValue('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('recovers a plan followed by trailing content', () => {
    // The live failure: "Unexpected non-whitespace character after JSON at
    // position 12384" is JSON.parse reading a good object and then finding more
    // text behind it. The plan was usable and was thrown away.
    expect(parseFirstJsonValue('{"ok":true} trailing junk')).toEqual({ ok: true });
    expect(parseFirstJsonValue('{"a":1}{"b":2}')).toEqual({ a: 1 });
  });

  it('recovers a plan wrapped in a markdown fence or preamble', () => {
    expect(parseFirstJsonValue('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(parseFirstJsonValue('Here is the plan:\n{"ok":true}')).toEqual({ ok: true });
  });

  it('is not confused by braces inside strings', () => {
    // A hook is free to contain a brace; counting it as structure would
    // truncate the value at the wrong place.
    expect(parseFirstJsonValue('{"hook":"a } b {","n":1} tail')).toEqual({
      hook: 'a } b {',
      n: 1,
    });
    expect(parseFirstJsonValue('{"hook":"quote \\" and } brace"} tail')).toEqual({
      hook: 'quote " and } brace',
    });
  });

  it('refuses a truncated value rather than inventing a closing brace', () => {
    // Truncation means the model ran out of output tokens, which is caught
    // earlier and reported honestly. Silently completing it here would turn a
    // half-written plan into a plausible-looking wrong one.
    expect(() => parseFirstJsonValue('{"variations":[{"segments":[')).toThrow();
  });

  it('refuses text with no JSON in it at all', () => {
    expect(() => parseFirstJsonValue('I cannot help with that.')).toThrow(/no JSON/i);
    expect(() => parseFirstJsonValue('')).toThrow();
  });
});
