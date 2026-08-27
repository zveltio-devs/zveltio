/**
 * A filtered list is a link.
 *
 * Search, sort and page were component state and nothing else, so "the overdue
 * invoices, newest first" could not be reloaded, bookmarked, or sent to somebody.
 * A list you cannot link to is a list you have to describe.
 */
import { test, expect } from '@playwright/test';
import { E2E } from '../setup/env.js';

test('a search survives a reload and travels in the URL', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/admin/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('#login-email').fill(E2E.admin.email);
  await page.locator('#login-password').fill(E2E.admin.password);
  await page
    .getByRole('button', { name: /sign in$/i })
    .first()
    .click();
  await page.waitForTimeout(3500);

  const made = await page.evaluate(async () => {
    const name = `view_probe_${Date.now()}`;
    const c = await fetch('/api/collections', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fields: [{ name: 'title', type: 'text' }] }),
    });
    if (!c.ok) return { name, ok: false };
    for (const title of ['alpha one', 'beta two', 'alpha three']) {
      await fetch(`/api/data/${name}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
    }
    return { name, ok: true };
  });
  expect(made.ok).toBe(true);

  await page.goto(`/admin/collections/${made.name}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const search = page.locator('input[placeholder*="ecord"], input[type=search]').first();
  await search.fill('alpha');
  await page.waitForTimeout(1800);

  // The search is in the address bar…
  expect(page.url(), 'the search did not reach the URL').toContain('q=alpha');

  // …and it survives a reload, which is what makes it a link somebody can send.
  const url = page.url();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const back = page.locator('input[placeholder*="ecord"], input[type=search]').first();
  expect(await back.inputValue(), 'the search did not come back from the URL').toBe('alpha');
});
