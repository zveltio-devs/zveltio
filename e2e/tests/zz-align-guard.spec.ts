/**
 * Every field on a settings-style form shares one left edge.
 *
 * This is a regression guard for a specific and easy-to-repeat failure:
 * `form-control`, `label-text` and `label-text-alt` were REMOVED in DaisyUI 5
 * and emit no CSS, while this Studio uses them 362 times. With them gone, each
 * input started wherever its label text happened to end — five fields, five
 * different left edges — and `app.css` restores them.
 *
 * Asserted on the rendered page rather than on the stylesheet, because what
 * matters is the geometry, not which rule produced it.
 */
import { test, expect } from '@playwright/test';
import { E2E } from '../setup/env.js';

test('settings fields share one left edge', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/admin/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('#login-email').fill(E2E.admin.email);
  await page.locator('#login-password').fill(E2E.admin.password);
  await page.getByRole('button', { name: /sign in$/i }).first().click();
  await page.waitForTimeout(3500);
  await page.goto('/admin/settings/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const lefts = await page.evaluate(() => {
    const fields = Array.from(
      document.querySelectorAll('.form-control > .input, .form-control > .select'),
    ) as HTMLElement[];
    return [...new Set(fields.map((f) => Math.round(f.getBoundingClientRect().left)))];
  });
  expect(lefts.length, `fields start at ${lefts.length} different x positions: ${lefts}`).toBe(1);
});
