import { test, expect } from '@playwright/test';
import { E2E } from '../setup/env.js';
/**
 * Creating a key returns the key, and nothing that is not the key.
 *
 * The insert uses `returningAll()`, so the response used to carry `key_hash`
 * as well — a credential-adjacent value the caller has no use for, which then
 * sits in devtools, in network captures, and in client-side error reporting.
 * The listing beside it selects columns explicitly for exactly that reason.
 */
test('creating an API key returns the key and not its hash', async ({ page }) => {
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
  const r = await page.evaluate(async () => {
    const before = await (await fetch('/api/api-keys', { credentials: 'include' })).json();
    const made = await fetch('/api/api-keys', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'probe-' + Date.now(),
        scopes: [{ collection: '*', actions: ['read'] }],
      }),
    });
    const madeBody = await made.json().catch(() => ({}));
    const after = await (await fetch('/api/api-keys', { credentials: 'include' })).json();
    return {
      beforeN: (before.api_keys ?? []).length,
      createStatus: made.status,
      createdId: madeBody?.id ?? madeBody?.api_key?.id ?? null,
      createdKeys: Object.keys(madeBody),
      afterN: (after.api_keys ?? []).length,
      afterNames: (after.api_keys ?? []).map((k: any) => k.name),
    };
  });
  console.log('\n=== APIKEY ===\n' + JSON.stringify(r, null, 2));
  expect(r.createStatus).toBe(200);
  expect(r.createdKeys, 'the create response must not carry key_hash').not.toContain('key_hash');
  expect(r.createdKeys, 'the create response must carry the key itself').toContain('key');
  // The round trip: a key that was created is a key that is listed.
  expect(r.afterN).toBe(r.beforeN + 1);
});
