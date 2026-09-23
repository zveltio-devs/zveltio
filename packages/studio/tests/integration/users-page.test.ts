import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The users page, mounted against a live engine.
 *
 * `usersApi.list` returned the array alone and dropped `pagination`, so the
 * page counted the rows it had fetched as the whole list; and it sent
 * `offset` to a route that reads `page`, so the pager fetched page one
 * whatever was clicked.
 */
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/users') } }));

import { usersApi } from '$lib/api.js';
import Page from '../../src/routes/(admin)/users/+page.svelte';

const EMAIL = process.env.STUDIO_IT_EMAIL ?? 'e2e-admin@test.invalid';

afterEach(cleanup);

describe('users — against the engine', () => {
  it('renders the signed-in administrator', async () => {
    render(Page);
    await waitFor(() => expect(document.body.textContent).toContain(EMAIL));
  });

  it('the list carries the total the pager needs', async () => {
    const res = await usersApi.list({ limit: 1, page: 1 });
    expect(Array.isArray(res.users)).toBe(true);
    expect(typeof res.total).toBe('number');
    expect(res.total).toBeGreaterThanOrEqual(res.users.length);
  });

  it('a row carries the fields the table prints', async () => {
    const { users } = await usersApi.list({ limit: 20, page: 1 });
    const me = users.find((u: { email?: string }) => u.email === EMAIL);
    expect(me, 'the administrator is missing from the list').toBeDefined();
    for (const key of ['id', 'email', 'name', 'role']) expect(me).toHaveProperty(key);
  });

  it('a page past the end is empty, not page one again', async () => {
    const { total } = await usersApi.list({ limit: 1, page: 1 });
    const past = await usersApi.list({ limit: 1, page: total + 1 });
    expect(past.users).toEqual([]);
  });
});
