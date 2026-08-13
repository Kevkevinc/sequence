import { LogoMark } from '@/components/icons';

/**
 * Sign in and sign up, inside the same frame as everything else.
 *
 * Clerk ships its own card; the job here is to make it stop looking like a
 * stranger's card. The frame, the mark and the surface colour carry over, and
 * Clerk's own elements are re-pointed at the design's tokens rather than
 * restyled piece by piece.
 */
export function AuthScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="desk">
      <div className="frame">
        <div className="screen" data-flush="true" style={{ display: 'grid', alignContent: 'center' }}>
          <div style={{ display: 'grid', justifyItems: 'center', gap: 18, paddingTop: 20 }}>
            <LogoMark size={34} />
            {children}
          </div>
        </div>
        <div className="homeIndicator" />
      </div>
    </div>
  );
}

export const clerkAppearance = {
  variables: {
    colorPrimary: '#00d2ff',
    colorBackground: '#0c0c0c',
    colorText: '#ffffff',
    colorTextSecondary: 'rgba(255,255,255,0.55)',
    colorInputBackground: 'rgba(255,255,255,0.04)',
    colorInputText: '#ffffff',
    borderRadius: '15px',
    fontFamily: 'var(--font-inter), system-ui, sans-serif',
  },
  elements: {
    // Clerk's card brings its own border and shadow, which would sit as a
    // second panel inside the frame.
    cardBox: { boxShadow: 'none', border: 'none', width: '100%' },
    card: { background: 'transparent', boxShadow: 'none', border: 'none' },
    footer: { background: 'transparent' },
  },
} as const;
