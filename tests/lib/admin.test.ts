import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const currentUser = vi.fn();
vi.mock('@clerk/nextjs/server', () => ({ currentUser: () => currentUser() }));

const { checkAdmin } = await import('@/lib/admin');

function signedInAs(...emails: string[]) {
  currentUser.mockResolvedValue({
    emailAddresses: emails.map((emailAddress) => ({ emailAddress })),
  });
}

describe('checkAdmin', () => {
  const original = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    currentUser.mockReset();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = original;
  });

  it('refuses everyone when no admins are configured', async () => {
    delete process.env.ADMIN_EMAILS;
    signedInAs('owner@example.com');

    // The dashboard exposes every creator's jobs and the account's spend, so an
    // unset allow-list must deny rather than fall back to "the first account"
    // or to letting any signed-in creator through.
    expect(await checkAdmin()).toEqual({ allowed: false, reason: 'not-configured' });
  });

  it('treats a blank or comma-only list as no admins', async () => {
    process.env.ADMIN_EMAILS = ' , ,';
    signedInAs('owner@example.com');
    expect(await checkAdmin()).toEqual({ allowed: false, reason: 'not-configured' });
  });

  it('separates being signed out from not being an admin', async () => {
    process.env.ADMIN_EMAILS = 'owner@example.com';
    currentUser.mockResolvedValue(null);
    expect(await checkAdmin()).toEqual({ allowed: false, reason: 'signed-out' });

    signedInAs('someone-else@example.com');
    expect(await checkAdmin()).toEqual({ allowed: false, reason: 'not-an-admin' });
  });

  it('admits a listed address regardless of case or surrounding spaces', async () => {
    process.env.ADMIN_EMAILS = '  Owner@Example.com , other@example.com ';
    signedInAs('OWNER@example.COM');
    expect(await checkAdmin()).toEqual({ allowed: true, email: 'owner@example.com' });
  });

  it('admits a secondary address on the account, not just the first', async () => {
    // Signing in with a secondary address is still the same person; denying it
    // would look like a broken dashboard rather than a deliberate refusal.
    process.env.ADMIN_EMAILS = 'owner@example.com';
    signedInAs('personal@example.com', 'owner@example.com');
    expect(await checkAdmin()).toEqual({ allowed: true, email: 'owner@example.com' });
  });

  it('does not admit an address that merely contains an admin address', async () => {
    process.env.ADMIN_EMAILS = 'owner@example.com';
    signedInAs('not-owner@example.com.attacker.test');
    expect(await checkAdmin()).toEqual({ allowed: false, reason: 'not-an-admin' });
  });
});
