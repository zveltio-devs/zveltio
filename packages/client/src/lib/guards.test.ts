/**
 * `requireRole` — the client's routing guard.
 *
 * This function exists because the guard it replaced never ran: two
 * `+layout.server.ts` files fetched the session and redirected, under
 * `adapter-static` with `ssr = false`, so there was no server to execute them.
 * The code read correctly and did nothing, which is the failure mode this whole
 * file guards against — a protection asserted rather than held.
 *
 * It was rewritten once and shipped with no test. These pin the four decisions
 * it makes, including the two that are easy to get backwards: an unreachable
 * engine must send people to login rather than into the app, and a signed-in
 * user with the wrong role must be told which of the two problems they have.
 *
 * Read the guard's own docstring for what this is NOT: the engine authorises
 * every call, and a determined visitor can always skip client-side code. What
 * is tested here is that the right people land on the right page.
 */

import { describe, expect, it, vi } from 'vitest';
import { requireRole } from './guards';

/** SvelteKit's `redirect()` throws; this is the shape it throws. */
function asRedirect(e: unknown): { status: number; location: string } {
  const r = e as { status?: number; location?: string };
  if (typeof r?.status !== 'number' || typeof r?.location !== 'string') {
    throw new Error(`Not a redirect: ${String(e)}`);
  }
  return { status: r.status, location: r.location };
}

/**
 * Response bodies captured from a live engine (3.0.0-beta.69) — do not invent
 * fields here. The first version of this file mocked `get-session` with a
 * `role` it never carries, so the guard passed its tests and bounced every
 * real user, god included.
 */
const REAL = {
  /** better-auth's session: no role of any kind. */
  getSession: {
    session: { id: 's1', userId: 'u1', expiresAt: '2026-10-01T06:56:33.657Z' },
    user: { id: 'u1', name: 'emp', email: 'emp@x.test', emailVerified: false, image: null },
  },
  /** `/api/me` for a member holding the Casbin role `employee`. */
  employee: {
    user: { id: 'u1', name: 'emp', email: 'emp@x.test', role: 'member', roles: ['employee'] },
  },
  partner: {
    user: { id: 'u2', name: 'prt', email: 'prt@x.test', role: 'member', roles: ['partner'] },
  },
  /** A god holds no Casbin role; `god` is the `user.role` column. */
  god: { user: { id: 'u3', name: 'god', email: 'god@x.test', role: 'god', roles: [] } },
  /** `/api/me` anonymous: 401 with a problem document. */
  anonymous: { status: 401, title: 'Unauthorized', detail: 'Not authenticated' },
};

/**
 * A fetch that answers like the engine: `/api/me` with `me`, get-session with
 * the real session body. A guard that reads the wrong endpoint gets the wrong
 * answer here, as it would in production.
 */
function engineFetch(me: unknown, ok = true) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/api/auth/get-session')) {
      return { ok: true, json: async () => REAL.getSession } as unknown as Response;
    }
    if (url.endsWith('/api/me')) return { ok, json: async () => me } as unknown as Response;
    throw new Error(`unexpected fetch ${url}`);
  });
}

const url = (path: string) => new URL(`http://localhost${path}`);

const EMPLOYEE_GROUP = ['employee', 'manager', 'admin', 'god'];
const PARTNER_GROUP = ['partner', 'manager', 'admin', 'god'];

describe('requireRole', () => {
  it('lets a member holding the Casbin role in', async () => {
    const fetchFn = engineFetch(REAL.employee);

    const result = await requireRole(fetchFn as never, url('/employee/dashboard'), EMPLOYEE_GROUP);

    expect(result.user.id).toBe('u1');
    expect(result.user.roles).toEqual(['employee']);
  });

  it('lets a god into both portals, though a god holds no Casbin role', async () => {
    for (const allowed of [EMPLOYEE_GROUP, PARTNER_GROUP]) {
      const result = await requireRole(engineFetch(REAL.god) as never, url('/x'), allowed);
      expect(result.user.role).toBe('god');
    }
  });

  it('sends an anonymous visitor to login, remembering where they were going', async () => {
    // The returnTo is the point: without it, signing in drops you on a default
    // page and the link someone followed is lost.
    const fetchFn = engineFetch(REAL.anonymous, false);

    const err = await requireRole(fetchFn as never, url('/employee/reports'), EMPLOYEE_GROUP).catch(
      (e) => e,
    );

    const r = asRedirect(err);
    expect(r.status).toBe(302);
    expect(r.location).toBe('/auth/login?returnTo=%2Femployee%2Freports');
  });

  it('distinguishes a wrong role from not being signed in', async () => {
    // Same destination, different reason. A partner who lands on an employee
    // page has a different problem from a visitor, and the login screen needs
    // to be able to say so.
    const fetchFn = engineFetch(REAL.partner);

    const err = await requireRole(
      fetchFn as never,
      url('/employee/dashboard'),
      EMPLOYEE_GROUP,
    ).catch((e) => e);

    const r = asRedirect(err);
    expect(r.location).toBe('/auth/login?error=insufficient_role');
    expect(r.location).not.toContain('returnTo');
  });

  it('does not treat the `member` grade as a portal role', async () => {
    const fetchFn = engineFetch({ user: { ...REAL.employee.user, roles: [] } });

    const err = await requireRole(fetchFn as never, url('/employee/x'), EMPLOYEE_GROUP).catch(
      (e) => e,
    );

    expect(asRedirect(err).location).toBe('/auth/login?error=insufficient_role');
  });

  it('treats an unreachable engine as not signed in', async () => {
    // The tempting alternative — let them through and let the app fail on its
    // own — renders a shell that cannot load anything and looks broken. A
    // login page is a clearer failure.
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const err = await requireRole(fetchFn as never, url('/employee/x'), EMPLOYEE_GROUP).catch(
      (e) => e,
    );

    expect(asRedirect(err).location).toContain('/auth/login');
  });

  it('treats a non-OK response as not signed in', async () => {
    // A proxy or a restart can produce a 502 with a body that looks like a
    // user. That is not a licence to enter.
    const fetchFn = engineFetch(REAL.employee, false);

    const err = await requireRole(fetchFn as never, url('/employee/x'), EMPLOYEE_GROUP).catch(
      (e) => e,
    );

    expect(asRedirect(err).location).toContain('/auth/login');
  });

  it('sends the session cookie', async () => {
    // Without `credentials: 'include'` the request carries no cookie, the
    // engine answers "no session", and every authenticated user is bounced to
    // login — a total outage that looks like an auth bug.
    const fetchFn = engineFetch(REAL.employee);

    await requireRole(fetchFn as never, url('/employee/x'), EMPLOYEE_GROUP);

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('/api/me'),
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});
