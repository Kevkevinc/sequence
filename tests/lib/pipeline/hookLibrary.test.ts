import { describe, it, expect } from 'vitest';
import {
  CATALOG_HOOK_TEXTS,
  HOOK_CATALOG,
  displayHookText,
  hookCatalogForAudience,
  hooksForAudience,
  removeDisabledHooks,
} from '@/lib/pipeline/hookLibrary';

describe('hookCatalogForAudience', () => {
  it("gives a men's creator the men's groups plus the neutral one", () => {
    const ids = hookCatalogForAudience('mens').map((c) => c.id);
    expect(ids).toContain('general');
    expect(ids).toContain('fit');
    // Women's-cadence lines are not offered to a men's creator.
    expect(ids).not.toContain('reaction');
  });

  it("gives a women's creator only the neutral and reaction groups", () => {
    const ids = hookCatalogForAudience('womens').map((c) => c.id);
    expect(ids).toEqual(['general', 'reaction']);
  });

  it("gives an unset ('any') creator only the neutral group", () => {
    const ids = hookCatalogForAudience('any').map((c) => c.id);
    expect(ids).toEqual(['general']);
  });

  it('never shows a line the audience filter would exclude', () => {
    const shown = hookCatalogForAudience('mens').flatMap((c) => c.hooks);
    expect(shown.length).toBeGreaterThan(0);
    // Every shown line reads as neutral or men's — never women's cadence.
    expect(shown.every((h) => h.audience === 'any' || h.audience === 'mens')).toBe(true);
    // The custom-mode offer is a subset of what the catalogue shows a men's creator.
    const shownTexts = new Set(shown.map((h) => h.text));
    for (const text of hooksForAudience('mens')) {
      expect(shownTexts.has(text)).toBe(true);
    }
  });
});

describe('CATALOG_HOOK_TEXTS', () => {
  it('contains every line in the catalogue and nothing invented', () => {
    for (const category of HOOK_CATALOG) {
      for (const hook of category.hooks) {
        expect(CATALOG_HOOK_TEXTS.has(hook.text)).toBe(true);
      }
    }
    expect(CATALOG_HOOK_TEXTS.has('a line that was never in the library')).toBe(false);
  });
});

describe('removeDisabledHooks', () => {
  const library = ['the fit on this >', 'crazy [item]', 'hidden gem'];

  it('drops exactly the disabled lines, matched on raw text', () => {
    const kept = removeDisabledHooks(library, new Set(['crazy [item]']));
    expect(kept).toEqual(['the fit on this >', 'hidden gem']);
  });

  it('is a no-op when nothing is disabled', () => {
    expect(removeDisabledHooks(library, new Set())).toBe(library);
  });

  it('ignores disabled lines that are not in the library', () => {
    expect(removeDisabledHooks(library, new Set(['not here']))).toEqual(library);
  });

  it('keeps the whole library rather than return nothing when all are disabled', () => {
    const kept = removeDisabledHooks(library, new Set(library));
    expect(kept).toEqual(library);
  });
});

describe('displayHookText', () => {
  it('renders the [item] slot as a plain [product] token', () => {
    expect(displayHookText('the [item] on this >')).toBe('the [product] on this >');
  });

  it('leaves lines without the slot untouched', () => {
    expect(displayHookText('the fit on this >')).toBe('the fit on this >');
  });
});
