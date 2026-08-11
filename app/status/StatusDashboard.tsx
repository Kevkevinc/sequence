'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Operations dashboard.
 *
 * Deliberately a single scrolling column of plain cards: it is read on a phone,
 * usually because something is wrong, and the only thing that matters is that
 * the numbers are legible at a glance. Styling is local to this file rather
 * than added to the app's stylesheet — nothing else shares this layout, and an
 * internal tool should not widen the surface of the design system.
 */

const REFRESH_MS = 10_000;

type Status = {
  generatedAt: string;
  worker: {
    alive: boolean;
    staleAfterSeconds: number;
    instances: Array<{
      id: string;
      activity: string | null;
      startedAt: string;
      lastSeenAt: string;
      secondsAgo: number;
      uptimeSeconds: number;
    }>;
  };
  queue: {
    counts: Record<string, number>;
    inFlight: Array<{
      id: string;
      productName: string;
      status: string;
      variationCount: number;
      attempts: number;
      warning: string | null;
      rendersDone: number;
      rendersFailed: number;
      waitingSeconds: number;
    }>;
  };
  last24h: {
    jobsDone: number;
    jobsFailed: number;
    failedJobs: Array<{ id: string; productName: string; failureReason: string | null; attempts: number; createdAt: string }>;
    failedRenders: Array<{ id: string; jobId: string; failureReason: string | null; createdAt: string }>;
  };
  api: {
    last24h: { calls: number; costUsd: number; byKind: Array<{ kind: string; calls: number; promptTokens: number; outputTokens: number; costUsd: number }> };
    costMonthUsd: number;
    costAllTimeUsd: number;
    tokensMonth: number;
  };
  railway: { connected: true; costUsd: number } | { connected: false; reason: string };
};

/** Compact duration — a dashboard column has no room for "3600 seconds". */
function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d`;
}

function money(value: number): string {
  // Sub-cent spend is normal early on, and rounding it to $0.00 would read as
  // "nothing is being billed" rather than "a very small amount is".
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

const CSS = `
.st { max-width: 720px; margin: 0 auto; padding: 16px 14px 64px; }
.st-h { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.st-h1 { font-size: 20px; font-weight: 700; margin: 0; }
.st-sub { font-size: 12px; opacity: .6; }
.st-card { border: 1px solid rgba(128,128,128,.28); border-radius: 12px; padding: 14px; margin-bottom: 12px; }
.st-card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; opacity: .65; margin: 0 0 10px; font-weight: 600; }
.st-big { font-size: 26px; font-weight: 700; line-height: 1.1; }
.st-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 10px; }
.st-stat { padding: 8px 0; }
.st-stat .l { font-size: 11px; opacity: .6; text-transform: uppercase; letter-spacing: .04em; }
.st-stat .v { font-size: 20px; font-weight: 700; }
.st-row { display: flex; justify-content: space-between; gap: 10px; padding: 9px 0; border-top: 1px solid rgba(128,128,128,.18); font-size: 14px; }
.st-row:first-of-type { border-top: 0; }
.st-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; opacity: .75; word-break: break-word; }
.st-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
.st-ok { background: #16a34a; } .st-bad { background: #dc2626; } .st-warn { background: #d97706; }
.st-bar { height: 6px; border-radius: 999px; background: rgba(128,128,128,.25); overflow: hidden; margin-top: 6px; }
.st-bar > i { display: block; height: 100%; background: #16a34a; }
.st-err { font-size: 12px; opacity: .85; margin-top: 3px; word-break: break-word; }
.st-empty { font-size: 13px; opacity: .55; padding: 6px 0; }
.st-btn { border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
`;

export function StatusDashboard() {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(
          body.error === 'not-configured'
            ? 'No admins configured. Set ADMIN_EMAILS in your Vercel environment variables to your email address, then redeploy.'
            : body.error === 'signed-out'
              ? 'Sign in to view this page.'
              : 'This account is not on the admin list.'
        );
        setData(null);
        return;
      }
      setData(await res.json());
      setError(null);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The first load is scheduled rather than called straight from the effect
    // body. `load` flips `loading` synchronously, and doing that during the
    // effect makes React re-render immediately on mount — the cascading-render
    // pattern the lint rule exists to catch. A zero-delay timer puts it on the
    // next tick, which is also exactly what every subsequent poll does, so
    // both paths behave identically.
    const first = setTimeout(load, 0);
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  return (
    <div className="st">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="st-h">
        <h1 className="st-h1">Status</h1>
        <button className="st-btn" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="st-card">{error}</div>}
      {!data && !error && <div className="st-card st-empty">Loading…</div>}

      {data && (
        <>
          <div className="st-card">
            <h2>Worker</h2>
            <div className="st-big">
              <span className={`st-dot ${data.worker.alive ? 'st-ok' : 'st-bad'}`} />
              {data.worker.alive ? 'Running' : 'Not responding'}
            </div>
            {data.worker.instances.length === 0 && (
              <div className="st-empty">
                No worker has ever checked in. If the worker is deployed, it has not picked up
                this build yet.
              </div>
            )}
            {data.worker.instances.map((w) => (
              <div key={w.id} className="st-row">
                <div>
                  <div>{w.activity ?? 'idle'}</div>
                  <div className="st-mono">{w.id}</div>
                </div>
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div>{duration(w.secondsAgo)} ago</div>
                  <div className="st-mono">up {duration(w.uptimeSeconds)}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="st-card">
            <h2>Queue</h2>
            <div className="st-grid">
              {Object.entries(data.queue.counts).map(([label, count]) => (
                <div className="st-stat" key={label}>
                  <div className="l">{label}</div>
                  <div className="v">{count}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="st-card">
            <h2>In progress ({data.queue.inFlight.length})</h2>
            {data.queue.inFlight.length === 0 && <div className="st-empty">Nothing in the queue.</div>}
            {data.queue.inFlight.map((job) => {
              const pct = job.variationCount
                ? Math.round((job.rendersDone / job.variationCount) * 100)
                : 0;
              return (
                <div key={job.id} className="st-row" style={{ display: 'block' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <strong>{job.productName}</strong>
                    <span style={{ whiteSpace: 'nowrap', opacity: 0.7 }}>{duration(job.waitingSeconds)}</span>
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.75 }}>
                    {job.status}
                    {job.status === 'rendering' && ` — ${job.rendersDone}/${job.variationCount}`}
                    {job.rendersFailed > 0 && ` · ${job.rendersFailed} failed`}
                    {job.attempts > 0 && ` · retry ${job.attempts}`}
                  </div>
                  {job.status === 'rendering' && (
                    <div className="st-bar"><i style={{ width: `${pct}%` }} /></div>
                  )}
                  {job.warning && <div className="st-err">⚠ {job.warning}</div>}
                </div>
              );
            })}
          </div>

          <div className="st-card">
            <h2>Last 24 hours</h2>
            <div className="st-grid">
              <div className="st-stat"><div className="l">Done</div><div className="v">{data.last24h.jobsDone}</div></div>
              <div className="st-stat"><div className="l">Failed</div><div className="v">{data.last24h.jobsFailed}</div></div>
              <div className="st-stat"><div className="l">API calls</div><div className="v">{data.api.last24h.calls}</div></div>
            </div>
          </div>

          <div className="st-card">
            <h2>Errors (24h)</h2>
            {data.last24h.failedJobs.length === 0 && data.last24h.failedRenders.length === 0 && (
              <div className="st-empty">No failures.</div>
            )}
            {data.last24h.failedJobs.map((job) => (
              <div key={job.id} className="st-row" style={{ display: 'block' }}>
                <strong>{job.productName}</strong>
                <div className="st-err">{job.failureReason ?? 'No reason recorded.'}</div>
              </div>
            ))}
            {data.last24h.failedRenders.map((render) => (
              <div key={render.id} className="st-row" style={{ display: 'block' }}>
                <div className="st-mono">variation of job {render.jobId.slice(0, 8)}</div>
                <div className="st-err">{render.failureReason}</div>
              </div>
            ))}
          </div>

          <div className="st-card">
            <h2>Gemini spend</h2>
            <div className="st-grid">
              <div className="st-stat"><div className="l">24h</div><div className="v">{money(data.api.last24h.costUsd)}</div></div>
              <div className="st-stat"><div className="l">30 days</div><div className="v">{money(data.api.costMonthUsd)}</div></div>
              <div className="st-stat"><div className="l">All time</div><div className="v">{money(data.api.costAllTimeUsd)}</div></div>
            </div>
            {data.api.last24h.byKind.map((row) => (
              <div key={row.kind} className="st-row">
                <span>{row.kind}</span>
                <span>
                  {row.calls} calls · {((row.promptTokens + row.outputTokens) / 1000).toFixed(0)}k tokens ·{' '}
                  {money(row.costUsd)}
                </span>
              </div>
            ))}
            <div className="st-empty">
              Counted from tokens the API reported, priced at the rates in GEMINI_INPUT_COST_PER_MTOK /
              GEMINI_OUTPUT_COST_PER_MTOK. Only calls made after this dashboard shipped are included.
            </div>
          </div>

          <div className="st-card">
            <h2>Railway</h2>
            {data.railway.connected ? (
              <div className="st-big">{money(data.railway.costUsd)}<span className="st-sub"> this month</span></div>
            ) : (
              <div className="st-empty">Not connected — {data.railway.reason}</div>
            )}
          </div>

          <div className="st-sub">
            Updated {new Date(data.generatedAt).toLocaleTimeString()} · auto-refreshes every{' '}
            {REFRESH_MS / 1000}s
          </div>
        </>
      )}
    </div>
  );
}
