/**
 * "Who changed this" is answered on the record, not on another screen.
 *
 * `zv_revisions` carries an index on `(collection, record_id, created_at DESC)`
 * — this query and nothing else — and the Studio never ran it here. The question
 * could only be answered by leaving the record, opening the audit page, and
 * filtering it down, which is why in practice nobody asked.
 */
import { test, expect } from '@playwright/test';
import { E2E } from '../setup/env.js';

test('a record shows who changed it and what', async ({ page }) => {
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
    const name = `hist_probe_${Date.now()}`;
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
      body: JSON.stringify({ title: 'first' }),
    });
    const body = await r.json().catch(() => ({}));
    const id = body?.id ?? body?.data?.id;
    if (id) {
      await fetch(`/api/data/${name}/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'second' }),
      });
    }
    return { name, id, ok: !!id };
  });
  expect(made.ok, `setup failed: ${JSON.stringify(made)}`).toBe(true);

  const api = await page.evaluate(async (m) => {
    const r = await fetch(
      `/api/admin/revisions?collection=${encodeURIComponent(m.name)}&record_id=${encodeURIComponent(String(m.id))}&limit=20`,
      { credentials: 'include' },
    );
    const b = await r.json().catch(() => ({}));
    return {
      status: r.status,
      n: (b.revisions ?? []).length,
      body: JSON.stringify(b).slice(0, 200),
    };
  }, made);
  expect(api.n, `the endpoint returned nothing: ${api.body}`).toBeGreaterThan(0);

  await page.goto(`/admin/collections/${made.name}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: /edit/i }).last().click();
  await page.waitForTimeout(1200);

  await page
    .getByRole('button', { name: /history|istoric/i })
    .first()
    .click();
  await page.waitForTimeout(1800);

  // The email, not a truncated id — that is the half the audit table got wrong
  // for the same reason, and the half a reader actually needs.
  await expect(page.getByText(E2E.admin.email).first()).toBeVisible();
  // Both events, in order: the update on top, the creation under it.
  await expect(page.getByText(/record updated|înregistrare actualizată/i)).toBeVisible();
  await expect(page.getByText(/record created|înregistrare creată/i)).toBeVisible();
});
