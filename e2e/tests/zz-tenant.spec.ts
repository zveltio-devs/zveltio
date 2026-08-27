/**
 * The unit switcher: it appears when there is somewhere to switch to, it names
 * the unit you are standing in, and moving sends `x-tenant-slug` from then on.
 *
 * Two things this had to get right and did not at first. `/api/tenants` is
 * instance-admin only AND is itself tenant-scoped, so it answers "which units
 * exist inside the unit I am already in" — one, always. And `/api/tenants/me`
 * answered from `zv_tenant_users` assignments, which returned an empty list to
 * an instance administrator: they bypass tenancy rather than being enrolled in
 * it, and they are the caller the endpoint exists for.
 */
import { test, expect } from '@playwright/test';
import { E2E } from '../setup/env.js';

test('the unit switcher lists the units a person may enter', async ({ page }) => {
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

  // A second unit, created the way an operator would.
  const made = await page.evaluate(async () => {
    const res = await fetch('/api/tenants', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Direcția Județeană Cluj',
        slug: 'cluj',
        admin_user_email: 'e2e-admin@test.invalid',
      }),
    });
    return { status: res.status };
  });
  expect([200, 201, 409]).toContain(made.status);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const names = await page.evaluate(async () => {
    const res = await fetch('/api/tenants/me', { credentials: 'include' });
    const b = await res.json().catch(() => ({}));
    return (b.tenants ?? []).map((t: { name: string }) => t.name);
  });
  expect(names.length, `units returned: ${JSON.stringify(names)}`).toBeGreaterThan(1);

  const switcher = page.getByRole('button', { name: /Default|Cluj/ }).first();
  await expect(switcher).toBeVisible();
  await switcher.click();
  await page.waitForTimeout(600);
  await expect(page.getByRole('option', { name: /Cluj/ })).toBeVisible();
  if (process.env.SHOT_DIR) {
    await page.screenshot({
      path: `${process.env.SHOT_DIR}/topbar-switcher.png`,
      clip: { x: 256, y: 0, width: 700, height: 240 },
    });
  }
});
