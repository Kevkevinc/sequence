'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

/**
 * What this phone actually reports.
 *
 * Layout bugs that only happen inside an installed iOS app cannot be reproduced
 * on a desktop, and a screenshot of one is not measurable: it arrives resized,
 * so every number read off it is a guess multiplied by an unknown scale. This
 * page asks the device instead. It is unlisted, unlinked and cheap to keep.
 */

type Row = { label: string; value: string };

export default function DebugInsets() {
  const [rows, setRows] = useState<Row[]>([]);

  function measure() {
    // A probe element is the only way to read the env() values: they are usable
    // in CSS but are not exposed to script directly.
    const probe = document.createElement('div');
    probe.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'visibility:hidden',
      'padding-top:env(safe-area-inset-top)',
      'padding-right:env(safe-area-inset-right)',
      'padding-bottom:env(safe-area-inset-bottom)',
      'padding-left:env(safe-area-inset-left)',
    ].join(';');
    document.body.appendChild(probe);
    const inset = getComputedStyle(probe);

    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;

    setRows([
      { label: 'Installed app', value: standalone ? 'YES' : 'NO (browser tab)' },
      { label: 'Safe top', value: inset.paddingTop },
      { label: 'Safe bottom', value: inset.paddingBottom },
      { label: 'Window height', value: `${window.innerHeight}px` },
      { label: 'Screen height', value: `${window.screen.height}px` },
      {
        label: 'Visual viewport',
        value: window.visualViewport ? `${Math.round(window.visualViewport.height)}px` : 'n/a',
      },
      { label: 'App box height', value: `${document.querySelector('.app')?.clientHeight ?? 0}px` },
      { label: 'Pixel ratio', value: String(window.devicePixelRatio) },
    ]);

    probe.remove();
  }

  useEffect(() => {
    // Measured on the next frame rather than during the effect, so the numbers
    // are read after the browser has settled the layout being asked about.
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
    // `measure` reads only browser globals and setRows, both stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <div className="screen" data-flush="true">
        <h1 className="detailTitle" style={{ padding: '10px 0 16px' }}>
          Device numbers
        </h1>
        <div className="groupedList">
          {rows.map((row) => (
            <div className="groupedRow" key={row.label}>
              <span style={{ fontSize: 15, fontWeight: 500 }}>{row.label}</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>
                {row.value}
              </span>
            </div>
          ))}
        </div>
        <p className="footnote" style={{ marginTop: 16 }}>
          Screenshot this page from inside the installed app and send it over.
        </p>

        {/* There is no browser back button in an installed app. */}
        <Link href="/profile" className="btn btnOutline btnFull" style={{ marginTop: 20 }}>
          Back to Sequence
        </Link>
      </div>
    </div>
  );
}
