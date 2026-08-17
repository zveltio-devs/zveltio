/**
 * SEC-10 / SEC-11 / SEC-12 — the pre-auth surfaces are rate limited, and each
 * has its own budget.
 *
 * Public form submission, share-link password entry, and SCIM all accept
 * traffic before anything has authenticated. Each had no ceiling, or a ceiling
 * living inside an extension process — which resets on deploy and counts
 * separately on every replica.
 *
 * Two things are asserted, and the second is the one that bites:
 *
 * 1. The limiter is reachable on the path it was mounted on. Middleware in this
 *    app is matched by registration order, and a pattern that does not match the
 *    live route produces no error anywhere — the limit simply never applies. The
 *    only way to know is to hit the path.
 *
 * 2. The budgets are separate. Sharing `authRateLimit` across all three means
 *    exhausting one locks the others out for the same address, and behind a
 *    single office NAT that address is everybody.
 *
 * The middleware short-circuits when NODE_ENV is 'test', so the environment is
 * flipped for the duration. Without that, this file would watch every request
 * return 404 and conclude the limits work, having measured the bypass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

/** A distinct source per surface, so one test cannot spend another's budget. */
const FORM_IP = '203.0.113.11';
const SHARE_IP = '203.0.113.12';
const SCIM_IP = '203.0.113.13';

d('pre-auth surface rate limits (in-process)', () => {
  let app: Hono;
  let savedEnv: string | undefined;
  let savedGate: string | undefined;
  let savedProxy: string | undefined;

  async function hit(path: string, ip: string) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'x-forwarded-for': ip, 'Content-Type': 'application/json' },
      body: '{}',
    });
    return res.status;
  }

  /** Fire `n` requests and report whether any was throttled. */
  async function burst(path: string, ip: string, n: number): Promise<number[]> {
    const seen: number[] = [];
    for (let i = 0; i < n; i++) seen.push(await hit(path, ip));
    return seen;
  }

  beforeAll(async () => {
    ({ app } = await getTestApp());
    savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    // The `/ext/*` auth gate is registered before these limiters (index.ts:586
    // vs 592), so on a live instance it runs first and calls next() for a route
    // an extension has declared public — after which the limiter applies. No
    // extension is loaded here, so the gate answers 401 to everything and the
    // limiter is never reached. Opening the gate makes this file measure the
    // limiter, which is its subject; the gate has its own tests.
    savedGate = process.env.ZVELTIO_EXT_AUTH_GATE;
    process.env.ZVELTIO_EXT_AUTH_GATE = '0';
    // Without TRUSTED_PROXY the limiter ignores X-Forwarded-For entirely — by
    // design, since an untrusted client can spoof it — and every request in
    // this file would land in one bucket per surface. The per-surface tests
    // would still pass, and the separation test would fail for the wrong
    // reason: budget already spent by its neighbours, not by a shared bucket.
    savedProxy = process.env.TRUSTED_PROXY;
    process.env.TRUSTED_PROXY = 'true';
  });

  afterAll(() => {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedGate === undefined) delete process.env.ZVELTIO_EXT_AUTH_GATE;
    else process.env.ZVELTIO_EXT_AUTH_GATE = savedGate;
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
  });

  // The handler behind each path may 404 in this harness — no extension is
  // loaded. That is fine and is in fact the cleanest form of the test: the
  // limiter sits in front of the handler, so a 429 proves the middleware
  // matched the path without depending on anything being mounted behind it.
  it('throttles public form submission (20/min)', async () => {
    const seen = await burst('/ext/forms/public/probe', FORM_IP, 25);
    expect(seen).toContain(429);
    // Not from the first request — a limiter that rejects everything would also
    // "contain 429" and would be an outage rather than a limit.
    expect(seen[0]).not.toBe(429);
  });

  it('throttles share-link attempts harder (10/min), because it is a password prompt', async () => {
    const seen = await burst('/ext/storage/cloud/share/tok', SHARE_IP, 14);
    expect(seen).toContain(429);
    expect(seen.indexOf(429)).toBeLessThan(12);
  });

  it('throttles SCIM (100/min) without punishing bulk provisioning', async () => {
    const seen = await burst('/scim/v2/Users', SCIM_IP, 105);
    expect(seen).toContain(429);
    // A directory sync pushing 50 users in a minute must not trip. A limiter
    // that fires there gets removed rather than tuned.
    expect(seen.slice(0, 50)).not.toContain(429);
  });

  // Declared first so it runs on budgets its neighbours have not spent.
  it('one client cannot lock another out', async () => {
    const abusive = '203.0.113.90';
    const innocent = '203.0.113.91';
    const seen = await burst('/scim/v2/Users', abusive, 105);
    expect(seen).toContain(429);

    // The in-memory branch of the limiter — the one used when no cache backend
    // is configured, which is the default shape of a small self-hosted install
    // — identified callers as `session?.id ?? 'unknown'`. It never looked at the
    // address, so every anonymous caller shared one bucket per surface. Since
    // these surfaces are anonymous by definition, that made each new limit a
    // switch any single visitor could throw: twenty form submissions and nobody
    // else could submit for the rest of the minute.
    expect(await hit('/scim/v2/Users', innocent)).not.toBe(429);
  });

  it('keeps the budgets separate — exhausting one leaves the others open', async () => {
    const ip = '203.0.113.14';
    // Spend the share budget completely.
    const share = await burst('/ext/storage/cloud/share/tok', ip, 14);
    expect(share).toContain(429);

    // The same address, on the other two surfaces, must still be served. This
    // is the regression a shared `authRateLimit` produced: ten failed SCIM
    // requests left public forms answering 429 having never been touched.
    expect(await hit('/ext/forms/public/probe', ip)).not.toBe(429);
    expect(await hit('/scim/v2/Users', ip)).not.toBe(429);
  });

  it('leaves an unrelated path alone', async () => {
    // Positive control. If /health started answering 429 the patterns would be
    // matching far more than intended, and every assertion above would still
    // pass.
    const res = await app.request('/health', { headers: { 'x-forwarded-for': SHARE_IP } });
    expect(res.status).not.toBe(429);
  });
});
