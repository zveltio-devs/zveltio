import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The permissions matrix, round-tripped through a live engine.
 *
 * `GET /api/admin/permissions` read the Casbin row's DOMAIN column as the
 * resource and the resource column as the action. Every saved grant came back
 * as `resource: '*'`, `action: '<collection>'`: the screen showed all boxes
 * unticked, and saving what it had loaded sent an action the bulk endpoint's
 * enum refuses — one grant made the screen unsavable. It also offered `view`,
 * which no check asks for (the data API asks for `read`).
 */
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/permissions') } }));

import { api } from '$lib/api.js';
import Page from '../../src/routes/(admin)/permissions/+page.svelte';

const ROLE = `it_role_${Date.now().toString(36)}`;
const COLLECTION = `it_perm_${Date.now().toString(36)}`;
type Perm = { role_id: string; resource: string; action: string };
let roleId: string;
let before: Perm[] = [];

beforeAll(async () => {
  await api.post('/api/collections', {
    name: COLLECTION,
    fields: [{ name: 'title', type: 'text' }],
  });
  roleId = (await api.post<{ role: { id: string } }>('/api/admin/roles', { name: ROLE })).role.id;
  before = (await api.get<{ permissions: Perm[] }>('/api/admin/permissions')).permissions;
});

afterAll(async () => {
  // `bulk` replaces every custom role's grants: put back what was there.
  await api.post('/api/admin/permissions/bulk', { permissions: before }).catch(() => {});
  await api.delete(`/api/admin/roles/${roleId}`).catch(() => {});
  await api.delete(`/api/collections/${COLLECTION}`).catch(() => {});
});

afterEach(cleanup);

describe('permissions — against the engine', () => {
  it('offers a collection the actions the data API checks', async () => {
    const { resources } = await api.get<{
      resources: Array<{ name: string; actions: string[] }>;
    }>('/api/admin/resources');
    const mine = resources.find((r) => r.name === COLLECTION);
    expect(mine?.actions).toEqual(['read', 'create', 'update', 'delete']);
  });

  it('a saved grant reads back as the same resource and action', async () => {
    await api.post('/api/admin/permissions/bulk', {
      permissions: [...before, { role_id: roleId, resource: COLLECTION, action: 'read' }],
    });
    const { permissions } = await api.get<{ permissions: Perm[] }>('/api/admin/permissions');
    expect(permissions).toContainEqual({ role_id: roleId, resource: COLLECTION, action: 'read' });
  });

  it('what the screen loads can be saved back unchanged', async () => {
    const { permissions } = await api.get<{ permissions: Perm[] }>('/api/admin/permissions');
    await expect(api.post('/api/admin/permissions/bulk', { permissions })).resolves.toBeDefined();
  });

  it('renders the matrix with the role in it', async () => {
    render(Page);
    await waitFor(() => expect(document.body.textContent).toContain(ROLE));
  });
});
