/**
 * `requireUser` — the App workspace's routing guard.
 *
 * This function exists because the guard it replaced never ran: two
 * `+layout.server.ts` files fetched the session and redirected, under
 * `adapter-static` with `ssr = false`, so there was no server to execute them.
 * The code read correctly and did nothing, which is the failure mode this whole
 * file guards against — a protection asserted rather than held.
 *
 * It was rewritten once and shipped with no test. These pin the decisions it
 * makes, including the one that is easy to get backwards: an unreachable
 * engine must send people to login rather than into the app.
 *
 * Read the guard's own docstring for what this is NOT: the engine authorises
 * every call, and a determined visitor can always skip client-side code. What
 * is tested here is that the right people land on the right page.
 */

import { describe, expect, it, vi } from 'vitest';
import { afterSignIn, requireUser } from './guards';

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

describe('requireUser', () => {
  it('lets a member holding a Casbin role in', async () => {
    const result = await requireUser(engineFetch(REAL.employee) as never, url('/app'));

    expect(result.user.id).toBe('u1');
    expect(result.user.roles).toEqual(['employee']);
  });

  it('lets in a signed-in user whatever their roles, god and none included', async () => {
    // The App is split from the Console by activity, not role (ADR 0006): what
    // the workspace shows is what the engine lets each caller read. The guard
    // this replaced admitted only employee/partner/manager/admin, so a role an
    // operator created was locked out of the whole app.
    for (const me of [
      REAL.god,
      REAL.partner,
      { user: { ...REAL.employee.user, roles: ['sales'] } },
      { user: { ...REAL.employee.user, roles: [] } },
    ]) {
      const result = await requireUser(engineFetch(me) as never, url('/app'));
      expect(result.user.id).toBe(me.user.id);
    }
  });

  it('sends an anonymous visitor to login, remembering where they were going', async () => {
    // The returnTo is the point: without it, signing in drops you on a default
    // page and the link someone followed is lost.
    const err = await requireUser(
      engineFetch(REAL.anonymous, false) as never,
      url('/app/data/orders'),
    ).catch((e) => e);

    const r = asRedirect(err);
    expect(r.status).toBe(302);
    expect(r.location).toBe('/auth/login?returnTo=%2Fapp%2Fdata%2Forders');
  });

  it('treats an unreachable engine as not signed in', async () => {
    // The tempting alternative — let them through and let the app fail on its
    // own — renders a shell that cannot load anything and looks broken. A
    // login page is a clearer failure.
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const err = await requireUser(fetchFn as never, url('/app/x')).catch((e) => e);

    expect(asRedirect(err).location).toContain('/auth/login');
  });

  it('treats a non-OK response as not signed in', async () => {
    // A proxy or a restart can produce a 502 with a body that looks like a
    // user. That is not a licence to enter.
    const err = await requireUser(engineFetch(REAL.employee, false) as never, url('/app/x')).catch(
      (e) => e,
    );

    expect(asRedirect(err).location).toContain('/auth/login');
  });

  it('sends the session cookie', async () => {
    // Without `credentials: 'include'` the request carries no cookie, the
    // engine answers "no session", and every authenticated user is bounced to
    // login — a total outage that looks like an auth bug.
    const fetchFn = engineFetch(REAL.employee);

    await requireUser(fetchFn as never, url('/app/x'));

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('/api/me'),
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

describe('afterSignIn', () => {
  const login = (q: string) => new URL(`http://localhost/auth/login${q}`);

  it('returns to where the guard sent the visitor from', () => {
    expect(afterSignIn(login('?returnTo=%2Fapp%2Fdata%2Forders%3Fpage%3D2'))).toBe(
      '/app/data/orders?page=2',
    );
  });

  it('lands in the workspace without a returnTo', () => {
    expect(afterSignIn(login(''))).toBe('/app');
  });

  it('never leaves this origin', () => {
    for (const to of [
      '//evil.test/x',
      'https://evil.test/x',
      '/\\evil.test/x',
      '/.//evil.test/x',
      '/..//evil.test/x',
      '/a/..//evil.test/x',
    ]) {
      expect(afterSignIn(login(`?returnTo=${encodeURIComponent(to)}`))).toMatch(/^\/(?!\/)/);
      expect(afterSignIn(login(`?returnTo=${encodeURIComponent(to)}`))).not.toContain('evil');
    }
  });
});
