import { notFound } from 'next/navigation';
import { checkAdmin } from '@/lib/admin';
import { StatusDashboard } from './StatusDashboard';

/**
 * Gate for the operations dashboard.
 *
 * A server component so the decision happens before any markup is sent. The
 * API behind the page is separately gated — that is what actually protects the
 * data — but a non-admin who navigated here would otherwise still be served a
 * page shell that says "Status" and quietly fails to load. Rendering
 * {@link notFound} instead means the route is indistinguishable from one that
 * does not exist, so the dashboard is not merely unreadable by other creators
 * but undiscoverable.
 *
 * The `not-configured` case is deliberately *not* a 404. If it were, an
 * operator who has not set ADMIN_EMAILS yet would be locked out of their own
 * dashboard with no indication why, which is the kind of dead end that gets
 * diagnosed as "the feature is broken".
 */
export const dynamic = 'force-dynamic';

export default async function StatusPage() {
  const admin = await checkAdmin();

  if (!admin.allowed) {
    if (admin.reason === 'not-configured') {
      return (
        <div style={{ maxWidth: 560, margin: '0 auto', padding: '32px 18px', lineHeight: 1.55 }}>
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>Status dashboard not configured</h1>
          <p style={{ opacity: 0.8, fontSize: 15 }}>
            Set <code>ADMIN_EMAILS</code> in your hosting environment to the email address you
            sign in with, then redeploy. Until then nobody can open this page.
          </p>
          <p style={{ opacity: 0.6, fontSize: 13, marginTop: 14 }}>
            Comma-separate the list to allow more than one address.
          </p>
        </div>
      );
    }
    notFound();
  }

  return <StatusDashboard />;
}
