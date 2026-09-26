import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The tenants page, mounted against a live engine.
 *
 * The page used to post a `plan` and a billing e-mail, list plan badges and
 * record bars, and edit per-tenant limits. The engine has none of that now
 * (migration 018), so the create form must still produce a tenant the list
 * shows, and nothing the engine returns may be read as a plan or a limit.
 */
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/tenants') } }));

import { api } from '$lib/api.js';
import Page from '../../src/routes/(admin)/tenants/+page.svelte';

const SLUG = `it-tenant-${Date.now().toString(36)}`;
const NAME = `IT Tenant ${SLUG}`;
const ADMIN = process.env.STUDIO_IT_EMAIL ?? 'e2e-admin@test.invalid';

afterEach(cleanup);

describe('tenants — against the engine', () => {
  it('creates a tenant through the form and lists it', async () => {
    const { container, getByText } = render(Page);
    await waitFor(() => expect(getByText('New tenant')).toBeTruthy());
    await fireEvent.click(getByText('New tenant'));

    const input = (id: string) => container.ownerDocument.getElementById(id) as HTMLInputElement;
    await waitFor(() => expect(input('tenant-slug')).not.toBeNull());
    await fireEvent.input(input('tenant-slug'), { target: { value: SLUG } });
    await fireEvent.input(input('tenant-name'), { target: { value: NAME } });
    await fireEvent.input(input('tenant-admin-email'), { target: { value: ADMIN } });
    await fireEvent.click(getByText('Create Tenant', { selector: 'button' }));

    await waitFor(() => expect(document.body.textContent).toContain(NAME), { timeout: 15_000 });
  });

  it('the engine returns no plan or limit fields for the page to show', async () => {
    const { tenants } = await api.get<{ tenants: Record<string, unknown>[] }>('/api/tenants');
    const mine = tenants.find((t) => t.slug === SLUG);
    expect(mine, 'the tenant created through the form is missing').toBeDefined();
    for (const k of ['plan', 'max_records', 'max_api_calls_day', 'max_users', 'billing_email']) {
      expect(mine).not.toHaveProperty(k);
    }
  });
});
