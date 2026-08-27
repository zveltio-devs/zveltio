/**
 * Undo means the request was never sent.
 *
 * That is the whole claim, and it is the one worth testing: a row that vanishes
 * and comes back is easy; a row that comes back after the DELETE already went
 * out is a lie, because this engine hard-deletes with no `deleted_at` anywhere.
 *
 * So the test counts DELETE requests, not pixels.
 */
import { test, expect } from '@playwright/test';
import { E2E } from '../setup/env.js';

test('undo stops the delete from ever being sent', async ({ page }) => {
  test.setTimeout(240_000);
  const deletes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE') deletes.push(r.url());
  });

  await page.goto('/admin/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('#login-email').fill(E2E.admin.email);
  await page.locator('#login-password').fill(E2E.admin.password);
  await page
    .getByRole('button', { name: /sign in$/i })
    .first()
    .click();
  await page.waitForTimeout(3500);

  // A collection with one record to delete.
  const made = await page.evaluate(async () => {
    const name = `undo_probe_${Date.now()}`;
    const c = await fetch('/api/collections', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fields: [{ name: 'title', type: 'text' }] }),
    });
    if (!c.ok) return { name, ok: false, status: c.status };
    const r = await fetch(`/api/data/${name}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'keep me' }),
    });
    return { name, ok: r.ok, status: r.status };
  });
  expect(made.ok, `setup failed: ${JSON.stringify(made)}`).toBe(true);

  await page.goto(`/admin/collections/${made.name}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await expect(page.getByText('keep me').first()).toBeVisible();

  // Delete, then take it back inside the window.
  await page
    .getByRole('button', { name: /delete|șterge/i })
    .last()
    .click();
  await page.waitForTimeout(500);
  await expect(page.getByText('keep me')).toHaveCount(0);
  await page
    .getByRole('button', { name: /undo|anulează/i })
    .first()
    .click();
  await page.waitForTimeout(600);
  await expect(page.getByText('keep me').first()).toBeVisible();

  // Past the window, nothing must have gone out.
  await page.waitForTimeout(6000);
  expect(deletes, `a DELETE was sent despite the undo:\n${deletes.join('\n')}`).toEqual([]);

  // And the row is really still there, not merely on screen.
  const still = await page.evaluate(async (n) => {
    const r = await fetch(`/api/data/${n}`, { credentials: 'include' });
    const b = await r.json().catch(() => ({}));
    return (b.data ?? b.records ?? []).length;
  }, made.name);
  expect(still).toBe(1);
});

test('letting the window close does send the delete', async ({ page }) => {
  // The other half. A window that never fires is not an undo, it is a table
  // that quietly refuses to delete anything.
  test.setTimeout(240_000);
  const deletes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE') deletes.push(r.url());
  });

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
    const name = `undo_probe2_${Date.now()}`;
    const c = await fetch('/api/collections', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fields: [{ name: 'title', type: 'text' }] }),
    });
    if (!c.ok) return { name, ok: false };
    const r = await fetch(`/api/data/${name}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'goodbye' }),
    });
    return { name, ok: r.ok };
  });
  expect(made.ok).toBe(true);

  await page.goto(`/admin/collections/${made.name}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page
    .getByRole('button', { name: /delete|șterge/i })
    .last()
    .click();
  await page.waitForTimeout(7000);

  expect(deletes.length, 'the delete never went out').toBeGreaterThan(0);
  const left = await page.evaluate(async (n) => {
    const r = await fetch(`/api/data/${n}`, { credentials: 'include' });
    const b = await r.json().catch(() => ({}));
    return (b.data ?? b.records ?? []).length;
  }, made.name);
  expect(left).toBe(0);
});
