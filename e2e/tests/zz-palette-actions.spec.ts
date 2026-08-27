/**
 * The palette does things, and `?` explains the keyboard.
 *
 * A palette that only navigates leaves a person one keystroke from the page and
 * then back on the mouse. Actions are expressed as URLs with `?new=1`, so the
 * same action also survives a bookmark and a paste into chat.
 */
import { test, expect } from '@playwright/test';
import { E2E } from '../setup/env.js';

test('the palette creates, and ? shows the keyboard map', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/admin/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('#login-email').fill(E2E.admin.email);
  await page.locator('#login-password').fill(E2E.admin.password);
  await page
    .getByRole('button', { name: /sign in$/i })
    .first()
    .click();
  await page.waitForTimeout(3500);

  // `?` opens the map, and closing it leaves nothing behind.
  await page.keyboard.press('?');
  await page.waitForTimeout(600);
  await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeVisible();
  await page.keyboard.press('Escape').catch(() => {});
  await page
    .getByRole('button', { name: /close/i })
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(400);

  // …but not while typing one into a field.
  await page.goto('/admin/collections/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const search = page.locator('input[placeholder*="earch"]').first();
  await search.fill('');
  await search.press('?');
  await page.waitForTimeout(400);
  expect(await search.inputValue(), 'a shortcut must not eat a character out of a field').toBe('?');
  await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeHidden();

  // The palette runs an action rather than only navigating.
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(700);
  await page.keyboard.type('new collection');
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await expect(page.locator('dialog.modal-open')).toBeVisible();
  // The URL is clean again: `?new=1` opened the dialog and was consumed, so a
  // back navigation does not reopen it.
  expect(page.url()).not.toContain('new=1');
});
