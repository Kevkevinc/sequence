'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Toast } from '@/components/ui';
import { IconInfo } from '@/components/icons';

export default function ProfilePage() {
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const clearToast = useCallback(() => setToast(null), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/profile');
        if (!res.ok) {
          throw new Error(
            res.status === 401
              ? 'You need to be signed in to view your profile.'
              : `Could not load your profile (error ${res.status}). Please try again.`
          );
        }
        const data = await res.json();
        if (!cancelled) {
          setHeight(data?.height ?? '');
          setWeight(data?.weight ?? '');
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Could not load your profile.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    setSaveError(null);
    setSaving(true);

    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ height, weight }),
      });

      if (!res.ok) {
        // The API returns JSON errors for 400s but plain text for 401/404, so
        // only try to parse JSON when the server says that's what it sent.
        let message = `Could not save your profile (error ${res.status}). Please try again.`;
        if (res.status === 401) {
          message = 'You need to be signed in to save your profile.';
        } else if (res.headers.get('content-type')?.includes('application/json')) {
          const body = await res.json().catch(() => null);
          if (body?.error) message = body.error;
        }
        setSaveError(message);
        return;
      }

      setToast('Profile saved');
    } catch {
      setSaveError('Could not reach the server. Please check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell title="Profile" subtitle="Measurements for the sizing overlay">
      <div style={{ maxWidth: 520 }}>
        {loading && <div style={{ color: 'var(--text-3)', fontSize: 14 }}>Loading…</div>}

        {!loading && loadError && (
          <div className="banner" data-tone="failed">
            {loadError}
          </div>
        )}

        {!loading && !loadError && (
          <>
            <section className="glass card">
              <div className="formSection">
                <label className="label" htmlFor="height">
                  Height
                </label>
                <input
                  id="height"
                  className="input"
                  value={height}
                  onChange={(e) => setHeight(e.target.value)}
                  placeholder={'e.g. 5\'10"'}
                />
              </div>

              <div className="formSection">
                <label className="label" htmlFor="weight">
                  Weight
                </label>
                <input
                  id="weight"
                  className="input"
                  value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                  placeholder="e.g. 170 lbs"
                />
                <p className="helper">
                  These get burned into every video as the sizing overlay, above the size worn.
                  Leave one blank and it is simply left off.
                </p>
              </div>

              <div style={{ paddingTop: 22 }}>
                <button className="btn btnAccent" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </section>

            {saveError && (
              <div className="banner" data-tone="failed" style={{ marginTop: 16 }}>
                {saveError}
              </div>
            )}

            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                marginTop: 18,
                fontSize: 13,
                color: 'var(--text-faint)',
                lineHeight: 1.5,
              }}
            >
              <IconInfo size={16} />
              Sign-in &amp; account are handled securely by Clerk, nothing to manage here.
            </div>

            {/* Repeated here because the sidebar's version tag is hidden on
                phones, and a tester on a phone is exactly who gets asked
                "what version are you on?". */}
            <div
              style={{
                marginTop: 14,
                textAlign: 'center',
                fontFamily: 'var(--font-space-mono), ui-monospace, monospace',
                fontSize: 11,
                letterSpacing: '0.08em',
                color: 'var(--text-faint)',
              }}
            >
              Cutloop v{process.env.NEXT_PUBLIC_APP_VERSION}
            </div>
          </>
        )}
      </div>

      {toast && <Toast message={toast} onDone={clearToast} />}
    </AppShell>
  );
}
