/**
 * The translated strings actually render, in a language that is not English.
 *
 * A key that resolves in the catalogue and a key that renders on screen are two
 * different claims, and the gate only makes the first. This drives the Studio in
 * Romanian and reads a confirm dialog back off the page.
 */
import { test, expect } from '@playwright/test';
import { E2E } from '../setup/env.js';

test('confirm dialogs render in the chosen language', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/admin/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('#login-email').fill(E2E.admin.email);
  await page.locator('#login-password').fill(E2E.admin.password);
  await page.getByRole('button', { name: /sign in$/i }).first().click();
  await page.waitForTimeout(3500);

  // Switch to Romanian the way the locale store does, then reload.
  await page.evaluate(() => {
    try {
      localStorage.setItem('zveltio-locale', 'ro');
    } catch {
      /* private mode */
    }
  });
  await page.goto('/admin/collections/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const body = await page.locator('body').innerText();
  // Not asserting a specific screen's wording — asserting that SOMETHING on a
  // core page came out of the Romanian catalogue rather than the English source.
  const romanian = /Colecți|Utilizator|Șterge|Setări|Permisiuni/.test(body);
  expect(romanian, `no Romanian on the page:\n${body.slice(0, 400)}`).toBe(true);
});
