import { buildStatusSnapshot } from '@/lib/status/snapshot';
import { checkAdmin } from '@/lib/admin';

/**
 * Always computed fresh. A cached operations dashboard is worse than no
 * dashboard: the entire question it answers is "what is happening right now".
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const admin = await checkAdmin();
  if (!admin.allowed) {
    // 'not-configured' is surfaced so the operator can fix their own setup;
    // it says nothing about who the admins are, so it leaks nothing useful.
    const status = admin.reason === 'signed-out' ? 401 : 403;
    return Response.json({ error: admin.reason }, { status });
  }

  return Response.json(await buildStatusSnapshot());
}
