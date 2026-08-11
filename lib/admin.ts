import { currentUser } from '@clerk/nextjs/server';

/**
 * Who may see the operations dashboard.
 *
 * Kept in an environment variable rather than the database or the source: the
 * dashboard exposes every creator's jobs, failure reasons and the account's
 * spend, so the list of people who can read it should be changeable without a
 * deploy and should not sit in a git history.
 *
 * Empty by default, and an empty list denies everyone. Defaulting to "the first
 * account that signed up" or to a baked-in address would both be ways of
 * turning a missing configuration into silent access, which is the wrong
 * direction to fail for an admin surface.
 */
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export type AdminCheck =
  | { allowed: true; email: string }
  | { allowed: false; reason: 'signed-out' | 'not-configured' | 'not-an-admin' };

/**
 * Decides whether the signed-in user may read the dashboard.
 *
 * Distinguishes "nobody is configured" from "you are not on the list" because
 * the two need completely different responses from the operator: one is a
 * setup step, the other is working as intended. Callers must not leak that
 * difference to an unauthenticated visitor.
 */
export async function checkAdmin(): Promise<AdminCheck> {
  const user = await currentUser();
  if (!user) return { allowed: false, reason: 'signed-out' };

  const allowList = adminEmails();
  if (allowList.length === 0) return { allowed: false, reason: 'not-configured' };

  // Every verified address on the account, not just the primary: an operator
  // who signs in with a secondary address is still the same person, and
  // silently denying them would look like a broken dashboard.
  const emails = user.emailAddresses.map((address) => address.emailAddress.toLowerCase());
  const match = emails.find((email) => allowList.includes(email));

  return match ? { allowed: true, email: match } : { allowed: false, reason: 'not-an-admin' };
}
