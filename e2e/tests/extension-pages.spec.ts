import { expect, test } from '@playwright/test';
import { browserAvailable } from '../setup/browser-available';
import { E2E } from '../setup/env';

/**
 * The extension pages open, and open without an error.
 *
 * Every one of these shipped broken and nothing noticed. `checklists` called a
 * path the engine has never served; `search` and `sms` used a `/extensions/`
 * prefix the router does not know; the CRM contacts tab answered 500 on a
 * column its own migration never created. Four visible modules, each dead on
 * arrival, each failing quietly — a 404 inside a fetch becomes a toast, and
 * toasts are easy to stop reading.
 *
 * Two static guards now cover the causes: `check-studio-api-prefix.ts` for the
 * wrong prefix and `check-sdui-contract.ts` for a schema that disagrees with
 * its API. Neither can see what this sees. A page can call the right URL with
 * the right fields and still throw while rendering, and only a browser
 * executing the bundle notices that nothing was painted.
 *
 * What is asserted is deliberately thin: the page reached its own content, and
 * no error toast appeared. Asserting on rows would tie the test to seed data
 * and it would start failing for reasons that are not defects.
 */

const PAGES = [
  { slug: 'checklists', name: 'workflow/checklists' },
  { slug: 'search', name: 'search' },
  { slug: 'sms', name: 'sms' },
  { slug: 'crm', name: 'crm (SDUI)' },
  { slug: 'forms', name: 'forms' },
] as const;

/** DaisyUI alert used by the toast store for failures. */
const ERROR_TOAST = '.alert-error, [data-toast-type="error"]';

/**
 * Sign in before navigating, because `/admin/*` redirects to the login form
 * otherwise — and every assertion below would then be made against that form.
 *
 * The first version of this file skipped it and failed on `main#admin-main`
 * being absent. The element exists; the page never got there. `page.request`
 * shares the context's cookie jar, so the API call is enough and there is no
 * reason to drive the form.
 */
async function signIn(page: import('@playwright/test').Page): Promise<void> {
  const res = await page.request.post(`${E2E.baseURL}/api/auth/sign-in/email`, {
    data: { email: E2E.admin.email, password: E2E.admin.password },
    headers: { Origin: E2E.baseURL },
  });
  expect(res.ok(), `sign-in failed: ${res.status()}`).toBe(true);
}

test.describe('extension pages', () => {
  test.beforeEach(async () => {
    test.skip(!(await browserAvailable()), 'no browser here — see the warning above');
  });

  for (const p of PAGES) {
    test(`${p.name} opens without an error toast`, async ({ page }) => {
      const failures: string[] = [];

      // A 4xx/5xx on a page's own data call is the shape every one of these
      // defects had. Collected rather than asserted inline so the failure names
      // the request instead of a timeout on a selector.
      page.on('response', (res) => {
        const url = res.url();
        if (!url.includes('/ext/') && !url.includes('/api/')) return;
        if (res.status() >= 400) failures.push(`${res.status()} ${new URL(url).pathname}`);
      });

      const consoleErrors: string[] = [];
      page.on('pageerror', (err) => consoleErrors.push(err.message));

      await signIn(page);
      await page.goto(`${E2E.baseURL}/admin/${p.slug}`, { waitUntil: 'networkidle' });

      // The shell renders before the page's data arrives, so waiting for the
      // shell alone would pass on a page whose every request failed.
      await expect(page.locator('main#admin-main')).toBeVisible({ timeout: 15_000 });

      expect(consoleErrors, `uncaught error on /admin/${p.slug}`).toEqual([]);
      expect(failures, `failed API calls on /admin/${p.slug}`).toEqual([]);
      await expect(page.locator(ERROR_TOAST)).toHaveCount(0);
    });
  }

  test('the retired CRM routes redirect rather than 404', async ({ page }) => {
    // `/admin/crm/contacts` and its siblings were a second implementation that
    // nothing linked to and that called an API without the `/ext/crm` prefix.
    // They are 301s now; a bookmark has to keep working, which is the whole
    // reason they were not simply deleted.
    await signIn(page);
    for (const old of ['contacts', 'organizations', 'transactions']) {
      await page.goto(`${E2E.baseURL}/admin/crm/${old}`, { waitUntil: 'networkidle' });
      await expect(page).toHaveURL(/\/admin\/crm\/?$/, { timeout: 10_000 });
    }
  });
});
