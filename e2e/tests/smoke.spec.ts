import { expect, test } from '@playwright/test';
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
 * Split by what each test NEEDS. Anything that only speaks HTTP lives in
 * `zzz-engine-http.spec.ts`, so a workstation without Chromium still runs it — a
 * suite that skips wholesale on a missing dependency teaches people to ignore
 * its result. That file sorts last for a second reason now: the first
 * `newContext` after a run of request-only tests was segfaulting Chromium. The
 * note below about collapsing two contexts into one was the same crash, read at
 * the time as one unlucky test.
 */

test.describe('Studio, in a browser', () => {
  test.beforeEach(async () => {
    test.skip(!(await browserAvailable()), 'no browser here — see the warning above');
  });

  test('boots its JavaScript and reaches a login form', async ({ page }) => {
    // One navigation, three assertions. This was two tests loading `/admin/`
    // into two browser contexts and asserting half each, which cost a context
    // for no coverage — and the second one failed three runs in a row on CI
    // with a Chromium segfault while every other test passed, on a commit that
    // changed nothing but whitespace. Whatever the runner is doing there, the
    // extra context was buying nothing.
    //
    // Merging is not a workaround dressed as a cleanup: both original
    // assertions are here, and the ordering makes them STRONGER. The error
    // check now runs after waiting for the login input, so anything thrown
    // during hydration is caught. Before, it ran immediately after `goto` and
    // an error a few hundred milliseconds later went unnoticed.
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(e.message));

    await page.goto('/admin/');

    // Something rendered. A blank page still has a <body>, so the assertion is
    // about content, not markup.
    await expect(page.locator('body')).not.toBeEmpty();

    // Asserting on the input rather than a heading keeps this from breaking on
    // copy changes, which is the usual reason a smoke suite starts getting
    // ignored.
    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible({
      timeout: 15_000,
    });

    // And nothing threw on the way. This is the half that catches a version
    // mismatch: the shell can paint before the first API call fails.
    expect(failures, `Uncaught errors while loading /admin/:\n${failures.join('\n')}`).toEqual([]);
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
