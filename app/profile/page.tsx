'use client';

import { useEffect, useState } from 'react';

export default function ProfilePage() {
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
    setSaved(false);
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

      setSaved(true);
    } catch {
      setSaveError('Could not reach the server. Please check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main>
        <h1>Your Profile</h1>
        <p>Loading...</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main>
        <h1>Your Profile</h1>
        <p style={{ color: 'red' }}>{loadError}</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Your Profile</h1>
      <label>
        Height
        <input value={height} onChange={(e) => setHeight(e.target.value)} placeholder={'e.g. 5\'6"'} />
      </label>
      <label>
        Weight
        <input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 135 lbs" />
      </label>
      <button onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save'}
      </button>
      {saved && <p>Saved.</p>}
      {saveError && <p style={{ color: 'red' }}>{saveError}</p>}
    </main>
  );
}
