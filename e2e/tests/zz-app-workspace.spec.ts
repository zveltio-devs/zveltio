/**
 * The App's workspace (ADR 0006): signing in on `/auth/login` with a `returnTo`
 * lands there, the navigation lists a collection the engine says this user may
 * read, and the generic screens list it and create a record in it.
 *
 * Which collections a member sees, and which of their fields, is the engine's
 * answer (`GET /api/data`) and is pinned in the harness
 * (data-readable-collections.test.ts); this is the browser half.
 */
import { test, expect } from '@playwright/test';
import { openAdminWindow } from '../setup/admin-window.js';
import { E2E } from '../setup/env.js';

test('the workspace lists a readable collection and creates a record in it', async ({ page }) => {
  test.setTimeout(240_000);
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));

  // The guard sends an anonymous visitor to login, remembering where they went.
  await page.goto('/app/account', { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/auth\/login\?returnTo=%2Fapp%2Faccount/);
  await page.locator('input[type=email]').fill(E2E.admin.email);
  await page.locator('input[type=password]').fill(E2E.admin.password);
  await page.locator('form button[type=submit]').click();
  await page.waitForURL(/\/app\/account$/);

  await openAdminWindow(page.context());
  const name = await page.evaluate(async () => {
    const n = `app_probe_${Date.now()}`;
    const c = await fetch('/api/collections', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: n,
        display_name: 'App probe',
        fields: [{ name: 'title', type: 'text' }],
      }),
    });
    return c.ok ? n : null;
  });
  expect(name, 'the collection was not created').not.toBeNull();
  // Creation is queued DDL; the collection appears once the table exists.
  await expect
    .poll(
      () =>
        page.evaluate(async (n) => {
          const r = await fetch(`/api/data/${n}`, { credentials: 'include' });
          return r.status;
        }, name),
      { timeout: 60_000 },
    )
    .toBe(200);

  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: 'App probe' }).click();
  await page.waitForURL(new RegExp(`/app/data/${name}$`));
  await expect(page.getByText('No records')).toBeVisible();

  await page.getByRole('link', { name: 'New' }).click();
  await page.locator('#f-title').fill('first from the app');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(new RegExp(`/app/data/${name}/[0-9a-f-]{36}$`));

  await page.getByRole('link', { name: 'App probe' }).first().click();
  await expect(page.getByRole('link', { name: 'first from the app' })).toBeVisible();

  expect(failures, `Uncaught errors in the workspace:\n${failures.join('\n')}`).toEqual([]);
});
