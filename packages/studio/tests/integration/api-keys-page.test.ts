import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The API-keys page, mounted against a live engine.
 *
 * Three things here were wrong while every unit test stayed green:
 *   - the form offered the action `write`, which `checkAccess` never asks for,
 *     so a key made with the form's defaults could not create or update;
 *   - the page sent `offset`, the route reads `page` — every page of the pager
 *     fetched the first one;
 *   - the route returned no `total`, so the pager counted the page it had.
 * And the key-write path answered 500 for every key (a revision row recorded
 * under `apikey:<uuid>`), which only a real key against a real engine shows.
 */
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/api-keys') } }));

import { api } from '$lib/api.js';
import Page from '../../src/routes/(admin)/api-keys/+page.svelte';

const BASE = window.localStorage.getItem('zveltio.engineUrl') as string;
const NAME = `it_key_${Date.now().toString(36)}`;
const COLLECTION = `it_keys_${Date.now().toString(36)}`;
// What the page's create form submits by default.
const FORM_DEFAULT_ACTIONS = ['read', 'create', 'update', 'delete'];

let id: string | undefined;
let plaintext: string | undefined;

beforeAll(async () => {
  await api.post('/api/collections', {
    name: COLLECTION,
    fields: [{ name: 'title', type: 'text' }],
  });
  // Collection DDL is applied asynchronously (202); wait until it answers.
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/data/${COLLECTION}?limit=1`).catch(() => null);
    if (r && r.status !== 404) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  const created = await api.post<{ id: string; key: string; key_prefix: string }>('/api/api-keys', {
    name: NAME,
    scopes: [{ collection: '*', actions: FORM_DEFAULT_ACTIONS }],
  });
  id = created.id;
  plaintext = created.key;
});

afterAll(async () => {
  if (id) await api.delete(`/api/api-keys/${id}`).catch(() => {});
  await api.delete(`/api/collections/${COLLECTION}`).catch(() => {});
});

afterEach(cleanup);

describe('api keys — against the engine', () => {
  it('renders a key the engine actually holds', async () => {
    render(Page);
    await waitFor(() => expect(document.body.textContent).toContain(NAME));
  });

  it('the list never carries the secret, and the prefix matches it', async () => {
    const res = await api.get<{ api_keys: Array<Record<string, unknown>>; total?: number }>(
      '/api/api-keys?limit=200&page=1',
    );
    const mine = res.api_keys.find((k) => k.id === id);
    expect(mine, 'created key missing from the list').toBeDefined();
    expect(JSON.stringify(res)).not.toContain(plaintext as string);
    expect(mine).not.toHaveProperty('key_hash');
    expect(plaintext?.startsWith(String(mine?.key_prefix))).toBe(true);
    for (const key of ['name', 'scopes', 'expires_at', 'last_used_at', 'is_active']) {
      expect(mine, `row lost ${key}`).toHaveProperty(key);
    }
    expect(Array.isArray(mine?.scopes), 'scopes came back as a string').toBe(true);
    expect(typeof res.total, 'the pager needs a total').toBe('number');
    expect(res.total).toBeGreaterThanOrEqual(res.api_keys.length);
  });

  it('page 2 is not page 1', async () => {
    const extra = await api.post<{ id: string }>('/api/api-keys', {
      name: `${NAME}_second`,
      scopes: [{ collection: '*', actions: ['read'] }],
    });
    try {
      const p1 = await api.get<{ api_keys: Array<{ id: string }> }>('/api/api-keys?limit=1&page=1');
      const p2 = await api.get<{ api_keys: Array<{ id: string }> }>('/api/api-keys?limit=1&page=2');
      expect(p2.api_keys[0]?.id).not.toBe(p1.api_keys[0]?.id);
    } finally {
      await api.delete(`/api/api-keys/${extra.id}`).catch(() => {});
    }
  });

  it("a key made with the form's default scopes can write", async () => {
    const res = await fetch(`${BASE}/api/data/${COLLECTION}`, {
      method: 'POST',
      // An explicit empty cookie keeps the setup's jar from attaching the god
      // session — which `authenticate` would prefer, and the key would be moot.
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': plaintext as string,
        cookie: '',
      },
      body: JSON.stringify({ title: 'written by key' }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
  });
});
