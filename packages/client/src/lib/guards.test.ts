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

/** A fetch that answers `get-session` with whatever body is given. */
function sessionFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);
}

const url = (path: string) => new URL(`http://localhost${path}`);

describe('requireRole', () => {
  it('returns the user when the role is allowed', async () => {
    const fetchFn = sessionFetch({ user: { id: 'u1', role: 'employee' } });

    const result = await requireRole(fetchFn as never, url('/employee/dashboard'), ['employee']);

    expect(result.user.id).toBe('u1');
    expect(result.user.role).toBe('employee');
  });

  it('sends an anonymous visitor to login, remembering where they were going', async () => {
    // The returnTo is the point: without it, signing in drops you on a default
    // page and the link someone followed is lost.
    const fetchFn = sessionFetch({});

    const err = await requireRole(fetchFn as never, url('/employee/reports'), ['employee']).catch(
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
    const fetchFn = sessionFetch({ user: { id: 'u2', role: 'partner' } });

    const err = await requireRole(fetchFn as never, url('/employee/dashboard'), ['employee']).catch(
      (e) => e,
    );

    const r = asRedirect(err);
    expect(r.location).toBe('/auth/login?error=insufficient_role');
    expect(r.location).not.toContain('returnTo');
  });

  it('treats an unreachable engine as not signed in', async () => {
    // The tempting alternative — let them through and let the app fail on its
    // own — renders a shell that cannot load anything and looks broken. A
    // login page is a clearer failure.
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const err = await requireRole(fetchFn as never, url('/employee/x'), ['employee']).catch(
      (e) => e,
    );

    expect(asRedirect(err).location).toContain('/auth/login');
  });

  it('treats a non-OK session response as not signed in', async () => {
    // better-auth answers 200 with a null body for an expired session, but a
    // proxy or a restart can produce a 502 here. Neither is a licence to enter.
    const fetchFn = sessionFetch({ user: { id: 'u3', role: 'employee' } }, false);

    const err = await requireRole(fetchFn as never, url('/employee/x'), ['employee']).catch(
      (e) => e,
    );

    expect(asRedirect(err).location).toContain('/auth/login');
  });

  it('accepts any of several allowed roles', async () => {
    const fetchFn = sessionFetch({ user: { id: 'u4', role: 'manager' } });

    const result = await requireRole(fetchFn as never, url('/employee/x'), ['employee', 'manager']);

    expect(result.user.role).toBe('manager');
  });

  it('sends the session cookie', async () => {
    // Without `credentials: 'include'` the request carries no cookie, the
    // engine answers "no session", and every authenticated user is bounced to
    // login — a total outage that looks like an auth bug.
    const fetchFn = sessionFetch({ user: { id: 'u5', role: 'employee' } });

    await requireRole(fetchFn as never, url('/employee/x'), ['employee']);

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/get-session'),
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});
