/**
 * Not a test — a capture pass. Drives the Studio and writes one screenshot per
 * page so a design review has something to look at other than source code.
 *
 * Kept out of the normal run by its filename prefix and the `@capture` tag.
 */
import { test } from '@playwright/test';
import { E2E } from '../setup/env.js';

const OUT = process.env.SHOT_DIR ?? '/tmp/shots';

// Trailing slashes are load-bearing: the Studio is a static SvelteKit build
// served under `base: '/admin'`, and the path without one does not resolve.
const PAGES: Array<[string, string]> = [
  ['01-dashboard', '/admin/'],
  ['02-collections', '/admin/collections/'],
  ['03-users', '/admin/users/'],
  ['04-permissions', '/admin/permissions/'],
  ['05-extensions', '/admin/extensions/'],
  ['06-marketplace', '/admin/marketplace/'],
  ['07-settings', '/admin/settings/'],
  ['08-storage', '/admin/storage/'],
  ['09-flows', '/admin/flows/'],
  ['10-insights', '/admin/insights/'],
  ['11-audit', '/admin/audit/'],
  ['12-tenants', '/admin/tenants/'],
  ['13-sql', '/admin/sql/'],
  ['14-account', '/admin/account/'],
];

test('@capture screenshots', async ({ page }) => {
  // Off by default. This is a capture pass, not an assertion, and the E2E suite
  // is deliberately small — `CAPTURE=1 bun x playwright test` runs it.
  test.skip(!process.env.CAPTURE, 'set CAPTURE=1 to write screenshots');
  test.setTimeout(480_000);
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)}`);
  });

  await page.goto('/admin/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/00-login.png`, fullPage: true });

  await page.locator('input[type=email]').first().fill(E2E.admin.email);
  await page.locator('input[type=password]').first().fill(E2E.admin.password);
  // Not `button[type=submit]`: the sign-in screen has no <form> and its buttons
  // are `type="button"`, driven by an onclick handler.
  await page
    .getByRole('button', { name: /sign in$/i })
    .first()
    .click();
  await page.waitForTimeout(4000);

  for (const [name, path] of PAGES) {
    await page.goto(path, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, path] of [
    ['90-mobile-dashboard', '/admin/'],
    ['91-mobile-collections', '/admin/collections/'],
  ] as Array<[string, string]>) {
    await page.goto(path, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  }

  if (problems.length) {
    console.log(`\n=== ${problems.length} probleme in consola ===`);
    for (const p of [...new Set(problems)].slice(0, 25)) console.log('  ' + p);
  }
});
