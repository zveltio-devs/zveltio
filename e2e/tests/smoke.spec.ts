import { expect, test } from '@playwright/test';
import { E2E } from '../setup/env';
import { browserAvailable } from '../setup/browser-available';

/**
 * The app comes up at all.
 *
 * This is the journey the suite was built for. An external audit reported the
 * admin UI as broken and spent its entire Studio pass on a black screen; the UI
 * was fine and the `studio-dist` bundle had been built for a different engine,
 * so the HTML loaded, the assets resolved, `curl` returned 200, and the
 * JavaScript died on an API shape that had changed.
 *
 * Nothing else in this repository can see that. A component test renders a
 * component in jsdom; an HTTP probe reads bytes. Only a browser executes the
 * bundle and notices that nothing was painted.
 *
 * Split by what each test NEEDS. Anything that only speaks HTTP stays out of
 * the browser-gated groups, so a workstation without Chromium still runs it — a
 * suite that skips wholesale on a missing dependency teaches people to ignore
 * its result.
 */

test.describe('Studio, in a browser', () => {
  test.beforeEach(async () => {
    test.skip(!(await browserAvailable()), 'no browser here — see the warning above');
  });

  test('serves the admin shell and boots its JavaScript', async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(e.message));

    await page.goto('/admin/');

    // Something rendered. A blank page still has a <body>, so the assertion is
    // about content, not markup.
    await expect(page.locator('body')).not.toBeEmpty();

    // And nothing threw on the way. This is the half that catches a version
    // mismatch: the shell can paint before the first API call fails.
    expect(failures, `Uncaught errors while loading /admin/:\n${failures.join('\n')}`).toEqual([]);
  });

  test('reaches a login form rather than an empty frame', async ({ page }) => {
    await page.goto('/admin/');

    // Asserting on the input rather than a heading keeps this from breaking on
    // copy changes, which is the usual reason a smoke suite starts getting
    // ignored.
    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe('the client portal, in a browser', () => {
  test.beforeEach(async () => {
    test.skip(!(await browserAvailable()), 'no browser here — see the warning above');
  });

  test('renders without throwing', async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(e.message));

    await page.goto('/');

    await expect(page.locator('body')).not.toBeEmpty();
    expect(failures, `Uncaught errors on /:\n${failures.join('\n')}`).toEqual([]);
  });
});

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
