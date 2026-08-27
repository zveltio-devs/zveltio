import { test, expect } from '@playwright/test';
import { E2E } from '../setup/env.js';

/**
 * A create dialog is a form, and the two things that follow from that are what
 * this asserts: Enter from a field submits it, and no button inside it submits
 * by accident.
 *
 * The second half is not hypothetical. A `<button>` with no `type` inside a
 * form defaults to SUBMIT, so the moment these dialogs became forms every
 * Cancel button in them would have started saving the thing it was meant to
 * abandon.
 */
test('create dialogs submit on Enter, and nothing else submits', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/admin/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('#login-email').fill(E2E.admin.email);
  await page.locator('#login-password').fill(E2E.admin.password);
  await page
    .getByRole('button', { name: /sign in$/i })
    .first()
    .click();
  await page.waitForTimeout(3500);

  await page.goto('/admin/api-keys/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  await page.getByRole('button', { name: 'Create Key', exact: true }).first().click();
  await page.waitForTimeout(900);

  const shape = await page.evaluate(() => {
    const dlgs = Array.from(document.querySelectorAll('dialog.modal-open'));
    const dlg = dlgs.find((d) => d.querySelector('#api-key-name')) ?? dlgs[0];
    const form = dlg?.querySelector('form');
    const btns = Array.from(dlg?.querySelectorAll('button') ?? []);
    return {
      dialogs: dlgs.length,
      titles: dlgs.map((d) => d.querySelector('h3')?.textContent?.trim().slice(0, 24)),
      hasForm: !!form,
      formsAnywhere: document.querySelectorAll('dialog.modal-open form').length,
      fieldsInsideForm: form ? form.querySelectorAll('input').length : 0,
      submitButtons: btns
        .filter((b) => (b as HTMLButtonElement).type === 'submit')
        .map((b) => b.textContent?.trim().slice(0, 20)),
      // Orice buton fara type explicit intr-un <form> trimite. Nu trebuie sa existe.
      implicitSubmit: btns.filter((b) => !b.getAttribute('type') && form?.contains(b)).length,
    };
  });
  console.log('\n=== MODAL ===\n' + JSON.stringify(shape, null, 2));
  expect(shape.hasForm).toBe(true);
  expect(shape.implicitSubmit).toBe(0);

  // Enter dintr-un camp trebuie sa creeze cheia.
  await page.locator('#api-key-name').fill('enter-key-probe');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  const created = await page
    .locator('dialog.modal-open')
    .innerText()
    .catch(() => '');
  expect(created).toContain('API Key');
  expect(errors, `uncaught errors while creating a key:\n${errors.join('\n')}`).toEqual([]);
});
