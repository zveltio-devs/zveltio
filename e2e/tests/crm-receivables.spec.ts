import { expect, test } from '@playwright/test';
import { E2E } from '../setup/env';
import { browserAvailable } from '../setup/browser-available';

/**
 * CRM dashboard widget (Model 2.5 ReceivablesCard).
 *
 * Requires the e2e boot to load `crm` (`EXTENSIONS_DIR` + `ZVELTIO_EXTENSIONS`)
 * and a Studio build that ran `sync-extensions` so the contribution is in the
 * bundle. Without those, this test skips rather than failing the whole suite.
 */

test.describe('CRM receivables widget', () => {
  test.beforeEach(async () => {
    test.skip(!(await browserAvailable()), 'no browser here — see the warning above');
  });

  test('renders on the admin dashboard after sign-in', async ({ page, request }) => {
    // Briefing exists only when CRM engine routes are mounted (401 without session).
    const briefingProbe = await request.get('/ext/crm/briefing');
    test.skip(
      briefingProbe.status() === 404,
      'crm not loaded — set EXTENSIONS_DIR + ZVELTIO_EXTENSIONS=crm (CI clones zveltio-extensions)',
    );

    const signIn = await page.request.post('/api/auth/sign-in/email', {
      data: { email: E2E.admin.email, password: E2E.admin.password },
    });
    expect(signIn.ok(), `Sign-in failed: ${await signIn.text()}`).toBe(true);

    // Avoid first-login redirect away from the dashboard (no collections yet).
    await page.addInitScript(() => {
      localStorage.setItem('zveltio-onboarding-done', '1');
    });

    await page.goto('/admin/');
    await expect(page.getByTestId('crm-receivables-widget')).toBeAttached({
      timeout: 20_000,
    });
    await expect(page.getByLabel('You are owed')).toBeAttached({ timeout: 5_000 });
  });
});
