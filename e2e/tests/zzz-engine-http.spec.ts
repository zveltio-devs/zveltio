/**
 * The engine, over HTTP — no browser involved.
 *
 * These lived in `smoke.spec.ts` until the position they occupied there started
 * crashing the run. Playwright orders files by name and this suite runs in one
 * worker, so the five `request`-only tests sat in the middle, and the FIRST
 * `browser.newContext` after them segfaulted:
 *
 *   Error: browser.newContext: Target page, context or browser has been closed
 *   [err] Received signal 11 SEGV_MAPERR 0000000001b0
 *
 * Always test #14, always that fault address, in 8 of 19 runs. Not the test that
 * took the hit: on 2026-08-27 10:55 slot #14 was `zz-design-capture`, and after
 * `zz-align-guard` was added forty minutes later the identical crash moved onto
 * it. The suite recovers immediately — #15 onward pass in the same run — so what
 * fails is re-entering the browser after a gap with no context open, not
 * anything either spec does.
 *
 * `smoke.spec.ts` already carries a note from an earlier round of this: two
 * browser tests were collapsed into one because the second "failed three runs in
 * a row on CI with a Chromium segfault ... on a commit that changed nothing but
 * whitespace". Same crash, treated then as one test being unlucky.
 *
 * So the gap is gone instead of moved: `zzz-` sorts after every `zz-` file, the
 * browser work is contiguous, and nothing asks for a context after these run.
 * Keeping them browser-free is also why they were split out in the first place —
 * a workstation without Chromium still runs them.
 */

import { expect, test } from '@playwright/test';
import { E2E } from '../setup/env';

test.describe('the engine, over HTTP', () => {
  test('health answers', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.ok()).toBe(true);
    expect((await res.json()).status).toBe('ok');
  });

  test('the Studio bundle was built for this engine', async ({ request }) => {
    // The version stamp is what turns "blank page" into a named cause at boot.
    // A missing marker means the pairing cannot be checked at all, which is the
    // state that produced the audit's lost day.
    const marker = await request.get('/admin/.zveltio-studio-version');
    expect(marker.status(), 'studio-dist carries no version marker').toBe(200);

    const stamped = (await marker.text()).trim();
    const health = await (await request.get('/health')).json();
    if (health.version) {
      expect(stamped, 'Studio bundle was built for a different engine').toBe(health.version);
    }
  });

  test('an anonymous request to an extension route is refused', async ({ request }) => {
    // `/ext/*` is fail-closed at the engine: a route whose author forgot a
    // session check answers 401 rather than serving a stranger. One assertion
    // covers every extension at once. A 404 is equally acceptable — this run
    // loads no extensions, and the point is that nothing anonymous is served.
    const res = await request.get('/ext/crm/contacts');
    expect([401, 404]).toContain(res.status());
    if (res.status() === 401) {
      expect((await res.json()).code).toBe('EXT_AUTH_REQUIRED');
    }
  });

  test('an anonymous request to the data API is refused', async ({ request }) => {
    const res = await request.get('/api/data/anything');
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('the admin account created for this run can sign in', async ({ request }) => {
    // Proves the fixture rather than the product, and it earns its place: every
    // other journey depends on it, and without this the failure surfaces as
    // whatever happened to run first.
    const res = await request.post('/api/auth/sign-in/email', {
      data: { email: E2E.admin.email, password: E2E.admin.password },
    });
    expect(res.ok(), `Sign-in failed: ${await res.text()}`).toBe(true);
  });
});
