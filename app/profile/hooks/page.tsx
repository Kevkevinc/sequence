'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppFrame, Screen } from '@/components/AppFrame';
import { IconChevronLeft } from '@/components/icons';

/**
 * The hook library, on its own screen.
 *
 * Reached from Profile. Every line the AI can burn onto a video is listed here,
 * grouped, each with a switch. Switching one off drops it from what the director
 * is offered, so a creator can steer the AI away from lines that don't sound
 * like them without touching anything else about their videos.
 */

type Hook = { text: string; display: string };
type Category = { id: string; label: string; hooks: Hook[] };

export default function HookLibraryPage() {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/profile/hooks')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setCategories(data.categories ?? []);
        setDisabled(new Set<string>(data.disabledHooks ?? []));
      })
      .catch(() => {
        if (!cancelled) setError('The hook library could not be loaded. Check your connection.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Collapses a burst of taps into one write and always sends the latest set,
  // rather than firing a request on every flick of a switch.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleSave(next: Set<string>) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/profile/hooks', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabledHooks: [...next] }),
        });
        setError(res.ok ? null : 'That change could not be saved. Try again.');
      } catch {
        setError('That change could not be saved. Check your connection.');
      }
    }, 400);
  }

  function toggle(text: string) {
    setDisabled((current) => {
      const next = new Set(current);
      if (next.has(text)) next.delete(text);
      else next.add(text);
      scheduleSave(next);
      return next;
    });
  }

  const total = categories?.reduce((sum, c) => sum + c.hooks.length, 0) ?? 0;
  const on = total - (categories ? [...disabled].filter((t) => isKnown(categories, t)).length : 0);

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
          Hook library
        </h1>
        <p className="meta" style={{ marginTop: 6 }}>
          Every line the AI can write onto your videos. Switch off anything that doesn&apos;t sound
          like you and the AI won&apos;t use it.
        </p>
      </header>

      <Screen>
        {error && (
          <div className="panel" data-tone="failure" style={{ marginBottom: 20 }}>
            <p className="panelText">{error}</p>
          </div>
        )}

        {categories && (
          <p className="footnote" style={{ marginBottom: 20 }}>
            {on} of {total} on. The AI still picks and adapts the exact wording per video —
            <span style={{ whiteSpace: 'nowrap' }}> [product]</span> fills in with your product.
          </p>
        )}

        {categories?.map((category) => (
          <section key={category.id} style={{ marginBottom: 26 }}>
            <p className="overline" style={{ marginBottom: 14 }}>
              {category.label}
            </p>
            <div className="groupedList">
              {category.hooks.map((hook) => {
                const isOn = !disabled.has(hook.text);
                return (
                  <div key={hook.text} className="groupedRow">
                    <span style={{ fontSize: 14, minWidth: 0, wordBreak: 'break-word' }}>
                      {hook.display}
                    </span>
                    <button
                      type="button"
                      className="toggle"
                      data-on={isOn}
                      aria-label={`${isOn ? 'Disable' : 'Enable'} "${hook.display}"`}
                      aria-pressed={isOn}
                      onClick={() => toggle(hook.text)}
                    >
                      <span className="toggleKnob" />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </Screen>
    </AppFrame>
  );
}

/** Whether a stored disabled line still exists in the shown catalogue. */
function isKnown(categories: Category[], text: string): boolean {
  return categories.some((c) => c.hooks.some((h) => h.text === text));
}
