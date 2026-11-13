import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { E2E } from '../../../../e2e/setup/env.js';
import { openConfigWindowOver } from '../../../engine/src/testing/step-up.js';

/**
 * The API-keys page as a tenant administrator who is not the instance's
 * (ADR 0046): it lists that tenant's keys, not the instance's, and mints one
 * there. The engine answered this page 403 for anyone but an instance admin.
 */
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/api-keys') } }));

import { api } from '#lib/api.js';
import Page from '../../src/routes/(admin)/api-keys/+page.svelte';

const BASE = window.localStorage.getItem('zveltio.engineUrl') as string;
const STAMP = Date.now().toString(36);
const SLUG = `it-tak-${STAMP}`;
const ADMIN = { email: `it-tak-${STAMP}@test.invalid`, password: 'ItTenantAdm1n!' };
const IN_TENANT = `it_tak_tenant_${STAMP}`;
const INSTANCE = `it_tak_root_${STAMP}`;
const MINTED = `it_tak_minted_${STAMP}`;
const GOD = {
  email: process.env.STUDIO_IT_EMAIL ?? E2E.admin.email,
  password: process.env.STUDIO_IT_PASSWORD ?? E2E.admin.password,
};

/** Sign in through the lane's cookie jar, which then speaks as this account. */
async function signIn(who: { email: string; password: string }, keyFile?: string) {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: '' },
    body: JSON.stringify(who),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((l) => l.split(';')[0])
    .join('; ');
  await openConfigWindowOver(BASE, cookie, who.password, BASE, keyFile);
}

const mintAsGod = (name: string, slug?: string) =>
  fetch(`${BASE}/api/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(slug ? { 'x-tenant-slug': slug } : {}) },
    body: JSON.stringify({ name, scopes: [{ collection: '*', actions: ['read'] }] }),
  });

beforeAll(async () => {
  const up = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: '' },
    body: JSON.stringify({ ...ADMIN, name: 'Tenant admin' }),
  });
  expect(up.ok, await up.clone().text()).toBe(true);
  await signIn(GOD, E2E.adminPasskeyFile);
  // Its owner is its administrator, and administers nothing else.
  await api.post('/api/tenants', { slug: SLUG, name: SLUG, admin_user_email: ADMIN.email });
  expect((await mintAsGod(IN_TENANT, SLUG)).status).toBe(200);
  expect((await mintAsGod(INSTANCE)).status).toBe(200);
  await signIn(ADMIN);
  window.localStorage.setItem('zveltio.tenantSlug', SLUG);
});

afterAll(() => {
  window.localStorage.removeItem('zveltio.tenantSlug');
});

afterEach(cleanup);

describe('api keys — a tenant administrator, against the engine', () => {
  it("lists the tenant's keys and not the instance's", async () => {
    render(Page);
    await waitFor(() => expect(document.body.textContent).toContain(IN_TENANT));
    expect(document.body.textContent).not.toContain(INSTANCE);
  });

  it('mints a key in the tenant through the form', async () => {
    render(Page);
    await waitFor(() => expect(document.body.textContent).toContain(IN_TENANT));
    const create = [...document.querySelectorAll('button')].find((b) =>
      /create|new/i.test(b.textContent ?? ''),
    );
    expect(create, 'no create button').toBeDefined();
    await fireEvent.click(create!);
    const name = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('#api-key-name');
      if (!el) throw new Error('no name input');
      return el;
    });
    await fireEvent.input(name, { target: { value: MINTED } });
    await fireEvent.submit(name.closest('form')!);
    await waitFor(() => expect(document.body.textContent).toContain(MINTED));

    const { api_keys } = await api.get<{
      api_keys: Array<{ name: string; is_instance_wide: boolean }>;
    }>('/api/api-keys?limit=200');
    const minted = api_keys.find((k) => k.name === MINTED);
    expect(minted?.is_instance_wide).toBe(false);
  });
});
