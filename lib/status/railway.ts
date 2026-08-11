/**
 * Railway spend, read from Railway's public GraphQL API.
 *
 * Optional by design. Everything else on the dashboard comes from this
 * project's own database and is therefore always correct; this panel talks to
 * a third party and can fail for reasons that have nothing to do with the app
 * (no token, expired token, API shape changed). It is written so that any of
 * those degrade to a labelled "unavailable" panel with the real reason,
 * because a dashboard that quietly shows $0.00 when it actually failed to ask
 * is worse than one that admits it does not know.
 */
const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

export type RailwayUsage =
  | { connected: true; costUsd: number; periodStart: string; periodEnd: string }
  | { connected: false; reason: string };

/**
 * Current billing period, as Railway measures it: the calendar month to date.
 * Both bounds are sent explicitly so the number on the dashboard means a
 * defined window rather than whatever the API happens to default to.
 */
function currentPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: start.toISOString(), end: now.toISOString() };
}

export async function fetchRailwayUsage(): Promise<RailwayUsage> {
  const token = process.env.RAILWAY_API_TOKEN;
  const workspaceId = process.env.RAILWAY_WORKSPACE_ID;

  if (!token) return { connected: false, reason: 'RAILWAY_API_TOKEN is not set' };
  if (!workspaceId) return { connected: false, reason: 'RAILWAY_WORKSPACE_ID is not set' };

  const { start, end } = currentPeriod();

  try {
    const response = await fetch(RAILWAY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        query: `
          query Usage($workspaceId: String!, $startDate: DateTime!, $endDate: DateTime!) {
            usage(workspaceId: $workspaceId, startDate: $startDate, endDate: $endDate) {
              estimatedUsage { value }
            }
          }
        `,
        variables: { workspaceId, startDate: start, endDate: end },
      }),
      // The dashboard must render even when Railway is slow; better a missing
      // panel than a status page that hangs.
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return { connected: false, reason: `Railway API returned ${response.status}` };
    }

    const body = await response.json();
    if (body.errors?.length) {
      return { connected: false, reason: `Railway API: ${body.errors[0]?.message ?? 'unknown error'}` };
    }

    // Summed rather than indexed: Railway reports usage per measurement
    // (CPU, memory, network, volume), and the dashboard wants the total.
    const entries: Array<{ value?: number }> = body.data?.usage?.estimatedUsage ?? [];
    const costUsd = entries.reduce((total, entry) => total + (entry.value ?? 0), 0);

    return { connected: true, costUsd, periodStart: start, periodEnd: end };
  } catch (error) {
    return {
      connected: false,
      reason: error instanceof Error ? error.message : 'Railway request failed',
    };
  }
}
