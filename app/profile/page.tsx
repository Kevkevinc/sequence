'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useClerk, useUser } from '@clerk/nextjs';
import { PhoneFrame, Screen } from '@/components/PhoneFrame';
import { CaptionLookPreview } from '@/components/CaptionLookPreview';
import { resolveCaptionSettings } from '@/lib/render/captionSettings';
import { captionFont } from '@/lib/render/fonts';
import { toPt } from '@/lib/captionUnits';

const AUDIENCES = [
  { value: 'mens', label: "Men's" },
  { value: 'womens', label: "Women's" },
  { value: 'any', label: 'Any' },
] as const;

type Audience = (typeof AUDIENCES)[number]['value'];

/** Representative rather than real: the AI writes the hook for each video. */
const PREVIEW_HOOK = 'THIS HOODIE ATE';

export default function ProfilePage() {
  const { user } = useUser();
  const { signOut } = useClerk();

  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [audience, setAudience] = useState<Audience>('any');
  const [captionSettings, setCaptionSettings] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/profile')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setHeight(data.height ?? '');
        setWeight(data.weight ?? '');
        setAudience(data.audience ?? 'any');
        setCaptionSettings(data.captionSettings ?? null);
      })
      .catch(() => {
        if (!cancelled) setError('Your profile could not be loaded. Check your connection.');
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Saved as the creator leaves a field rather than behind a Save button. There
   * are four values on this screen and no way to get any of them wrong, so a
   * button would only be a way to lose an edit by navigating away.
   */
  async function save(patch: Record<string, unknown>) {
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      setError(res.ok ? null : 'That change could not be saved. Try again.');
    } catch {
      setError('That change could not be saved. Check your connection.');
    }
  }

  const settings = resolveCaptionSettings(captionSettings);
  const font = captionFont(settings.fontId);
  const name = user?.fullName || user?.username || 'Your profile';
  const email = user?.primaryEmailAddress?.emailAddress ?? '';
  const initial = (user?.firstName || user?.username || email || 'S').charAt(0).toUpperCase();
  const sizingLine = [height, weight].filter(Boolean).join(' · ') || null;

  return (
    <PhoneFrame>
      <Screen>
        <header style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0 26px' }}>
          <span className="avatar" style={{ width: 60, height: 60, fontSize: 21 }}>
            {initial}
          </span>
          <span style={{ minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: 20,
                fontWeight: 600,
                letterSpacing: '-0.01em',
              }}
            >
              {name}
            </span>
            {email && (
              <span className="meta" style={{ display: 'block', marginTop: 2 }}>
                {email}
              </span>
            )}
          </span>
        </header>

        {error && (
          <div className="panel" data-tone="failure" style={{ marginBottom: 20 }}>
            <p className="panelText">{error}</p>
          </div>
        )}

        <p className="overline" style={{ marginBottom: 14 }}>
          Burned into your videos
        </p>
        <div className="groupedList">
          <div className="groupedRow">
            <label htmlFor="height" style={{ fontSize: 14, fontWeight: 500 }}>
              Height
            </label>
            <input
              id="height"
              className="groupedValue"
              value={height}
              placeholder="Add"
              onChange={(e) => setHeight(e.target.value)}
              onBlur={() => loaded && save({ height })}
            />
          </div>
          <div className="groupedRow">
            <label htmlFor="weight" style={{ fontSize: 14, fontWeight: 500 }}>
              Weight
            </label>
            <input
              id="weight"
              className="groupedValue"
              value={weight}
              placeholder="Add"
              onChange={(e) => setWeight(e.target.value)}
              onBlur={() => loaded && save({ weight })}
            />
          </div>
        </div>
        <p className="footnote" style={{ marginTop: 10 }}>
          These sit in the sizing line on every cut, above the size you wore. Leave one blank and
          it is simply left off.
        </p>

        <p className="overline" style={{ margin: '26px 0 14px' }}>
          You make content for
        </p>
        <div className="chipRow">
          {AUDIENCES.map((option) => (
            <button
              key={option.value}
              type="button"
              className="chip"
              style={{ flex: 1 }}
              data-active={audience === option.value}
              onClick={() => {
                setAudience(option.value);
                void save({ audience: option.value });
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="footnote" style={{ marginTop: 10 }}>
          Sets how the AI writes your hooks. Not sure? Leave it on Any and you get neutral lines.
        </p>

        <p className="overline" style={{ margin: '26px 0 14px' }}>
          Saved caption look
        </p>
        <div className="glass" style={{ display: 'flex', gap: 15, padding: 16, alignItems: 'center' }}>
          <CaptionLookPreview
            settings={settings}
            hook={PREVIEW_HOOK}
            sizing={sizingLine}
            width={58}
            grade="a"
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {font.label} · {toPt(settings.hookFontSize)}pt
            </div>
            <p className="cardDesc" style={{ marginTop: 4 }}>
              Every new video starts from this look.
            </p>
            <Link href="/profile/look" className="linkAccent" style={{ display: 'inline-block', marginTop: 8 }}>
              Edit look
            </Link>
          </div>
        </div>

        <button
          type="button"
          className="btn btnOutline btnFull"
          style={{ marginTop: 26 }}
          onClick={() => signOut({ redirectUrl: '/' })}
        >
          Sign out
        </button>

        <p className="footnote" style={{ marginTop: 14, textAlign: 'center' }}>
          Sequence v{process.env.NEXT_PUBLIC_APP_VERSION}
        </p>
      </Screen>
    </PhoneFrame>
  );
}
