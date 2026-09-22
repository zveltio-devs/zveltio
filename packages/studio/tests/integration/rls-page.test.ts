import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The RLS page, mounted against a live engine.
 *
 * It loads three routes in parallel and renders a row per policy. Its unit
 * sibling supplies all three by hand, so the page there cannot notice that
 * `/api/admin/rls` returns `{ policies }` rather than a bare array, that
 * `/api/admin/roles` needs a permission the operator may not hold, or that a
 * policy row lost the `filter_op` the table prints.
 */
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/rls') } }));

import { api } from '$lib/api.js';
import Page from '../../src/routes/(admin)/rls/+page.svelte';

const COLLECTION = `it_rls_${Date.now().toString(36)}`;
let policyId: string | undefined;

beforeAll(async () => {
  await api.post('/api/collections', {
    name: COLLECTION,
    display_name: 'Integration RLS',
    fields: [{ name: 'title', type: 'text' }],
  });
  const created = await api.post<{ policy?: { id: string }; id?: string }>('/api/admin/rls', {
    collection: COLLECTION,
    role: '*',
    filter_field: 'created_by',
    filter_op: 'eq',
    filter_value_source: 'user_id',
    is_enabled: true,
    description: 'own records',
  });
  policyId = created.policy?.id ?? created.id;
});

afterAll(async () => {
  if (policyId) await api.delete(`/api/admin/rls/${policyId}`).catch(() => {});
  await api.delete(`/api/collections/${COLLECTION}`).catch(() => {});
});

afterEach(cleanup);

describe('rls — against the engine', () => {
  it('lists a policy the engine actually holds', async () => {
    render(Page);
    // The description, not the collection name: the name also appears in the
    // form's collection picker, so asserting on it would pass with an empty
    // policy table.
    await waitFor(() => expect(document.body.textContent).toContain('own records'));
  });

  it('the three routes the page loads all answer this session', async () => {
    const [policies, collections, roles] = await Promise.all([
      api.get<{ policies: unknown[] }>('/api/admin/rls'),
      api.get<{ collections: unknown[] }>('/api/collections'),
      api.get<{ roles: unknown[] }>('/api/admin/roles'),
    ]);
    expect(Array.isArray(policies.policies)).toBe(true);
    expect(Array.isArray(collections.collections)).toBe(true);
    expect(Array.isArray(roles.roles)).toBe(true);
  });

  it('a policy carries the fields the table prints', async () => {
    const { policies } = await api.get<{ policies: Array<Record<string, unknown>> }>(
      '/api/admin/rls',
    );
    const mine = policies.find((p) => p.collection === COLLECTION);
    expect(mine, 'the created policy is missing from the list').toBeDefined();
    for (const key of ['role', 'filter_field', 'filter_op', 'filter_value_source', 'is_enabled']) {
      expect(mine, `policy row lost ${key}`).toHaveProperty(key);
    }
  });
});
