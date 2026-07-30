import { describe, it, expect } from 'vitest';
import { StyleConfigSchema } from '@/lib/styles';

describe('StyleConfigSchema', () => {
  it('accepts a minimal valid config', () => {
    const result = StyleConfigSchema.safeParse({
      cutMinSeconds: 2,
      cutMaxSeconds: 5,
      hookStyleLibrary: ['Affordable Designer Alternatives..'],
      variesClipOrder: true,
      usesInspirationOverlay: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts the optional textColor and sizingPlacement fields', () => {
    const result = StyleConfigSchema.safeParse({
      cutMinSeconds: 15,
      cutMaxSeconds: 45,
      hookStyleLibrary: ['new fav [item]'],
      textColor: '#ffcc00',
      sizingPlacement: 'bottom-right',
      variesClipOrder: false,
      usesInspirationOverlay: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a config missing a required field', () => {
    const result = StyleConfigSchema.safeParse({
      cutMinSeconds: 2,
      cutMaxSeconds: 5,
      hookStyleLibrary: ['x'],
      usesInspirationOverlay: false,
      // variesClipOrder missing
    });
    expect(result.success).toBe(false);
  });

  it('rejects a sizingPlacement outside the shared OVERLAY_PLACEMENTS list', () => {
    const result = StyleConfigSchema.safeParse({
      cutMinSeconds: 2,
      cutMaxSeconds: 5,
      hookStyleLibrary: ['x'],
      sizingPlacement: 'middle-of-nowhere',
      variesClipOrder: false,
      usesInspirationOverlay: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty hookStyleLibrary', () => {
    const result = StyleConfigSchema.safeParse({
      cutMinSeconds: 2,
      cutMaxSeconds: 5,
      hookStyleLibrary: [],
      variesClipOrder: false,
      usesInspirationOverlay: false,
    });
    expect(result.success).toBe(false);
  });
});
