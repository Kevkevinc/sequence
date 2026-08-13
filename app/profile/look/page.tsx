'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppFrame, Screen } from '@/components/AppFrame';
import { CaptionEditor } from '@/components/CaptionEditor';
import { IconChevronLeft } from '@/components/icons';
import {
  DEFAULT_CAPTION_SETTINGS,
  resolveCaptionSettings,
  type CaptionSettings,
} from '@/lib/render/captionSettings';

/**
 * The saved caption look, on its own screen.
 *
 * Reached from Profile. It is the same editor step 4 of the flow uses, so a
 * creator only ever learns one set of controls, but here it writes to the
 * profile instead of to one job.
 */

const PREVIEW_HOOK = 'THIS HOODIE ATE';

export default function CaptionLookPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<CaptionSettings | null>(null);
  const [sizingText, setSizingText] = useState<string | null>(null);
  const [hookText, setHookText] = useState(PREVIEW_HOOK);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/profile')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setSettings(resolveCaptionSettings(data?.captionSettings));
        const line = [data?.height, data?.weight].filter(Boolean).join(' · ');
        setSizingText(line || null);
      })
      .catch(() => {
        if (!cancelled) setSettings(resolveCaptionSettings(null));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ captionSettings: settings }),
      });
      if (!res.ok) {
        setError('That look could not be saved. Try again.');
        return;
      }
      router.push('/profile');
    } catch {
      setError('That look could not be saved. Check your connection.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppFrame showNav={false}>
      <header className="detailHeader">
        <button
          type="button"
          onClick={() => router.push('/profile')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 13,
            color: 'var(--text-meta)',
            minHeight: 44,
          }}
        >
          <IconChevronLeft size={15} />
          Profile
        </button>
        <h1 className="detailTitle" style={{ marginTop: 6 }}>
          Your caption look
        </h1>
        <p className="meta" style={{ marginTop: 6 }}>
          Every new video starts from this.
        </p>
      </header>

      <Screen flush>
        <div style={{ paddingTop: 18 }}>
          {settings && (
            <CaptionEditor
              settings={settings}
              onChange={(patch) => setSettings((current) => ({ ...current!, ...patch }))}
              hookText={hookText}
              onHookTextChange={setHookText}
              sizingText={sizingText}
              footer={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {error && (
                    <div className="panel" data-tone="failure">
                      <p className="panelText">{error}</p>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button
                      type="button"
                      className="btn btnOutline btnFull"
                      onClick={() => setSettings({ ...DEFAULT_CAPTION_SETTINGS })}
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      className="btn btnFull"
                      disabled={saving}
                      onClick={save}
                    >
                      {saving ? 'Saving' : 'Save look'}
                    </button>
                  </div>
                </div>
              }
            />
          )}
        </div>
      </Screen>
    </AppFrame>
  );
}
