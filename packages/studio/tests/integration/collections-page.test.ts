import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The collections list, mounted against a live engine.
 *
 * Its unit sibling (`src/routes/(admin)/collections/collections-page.test.ts`)
 * hands the page an object literal shaped like `{ collections: [...] }`. This
 * one asks the engine, so the page breaks here if `/api/collections` ever stops
 * answering that shape, if the list moves under an envelope, or if the route
 * starts requiring a permission the god session does not carry.
 *
 * Only the SvelteKit modules are stubbed. `$lib/api.js` is the real client, on
 * the real session installed by `tests/integration/setup.ts`.
 */
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/collections') } }));

import { api, collectionsApi } from '$lib/api.js';
import Page from '../../src/routes/(admin)/collections/+page.svelte';

const NAME = `it_coll_${Date.now().toString(36)}`;

beforeAll(async () => {
  await api.post('/api/collections', {
    name: NAME,
    display_name: 'Integration Widgets',
    fields: [{ name: 'title', type: 'text', required: true }],
  });
});

afterAll(async () => {
  await api.delete(`/api/collections/${NAME}`).catch(() => {});
});

afterEach(cleanup);

describe('collections list — against the engine', () => {
  it('renders a collection the engine actually has', async () => {
    render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('Integration Widgets'));
  });

  it('the list route answers the shape the page reads', async () => {
    const res = await collectionsApi.list();
    expect(Array.isArray(res.collections)).toBe(true);
    const mine = res.collections.find((c: { name: string }) => c.name === NAME);
    expect(mine, `${NAME} missing from /api/collections`).toBeDefined();
    // The page renders `display_name` and falls back to `name`; a rename of
    // either key leaves every row blank, which is what this asserts.
    expect(mine).toHaveProperty('display_name', 'Integration Widgets');
  });

  it('field types come back as a list, not a map', async () => {
    const res = await collectionsApi.fieldTypes();
    expect(Array.isArray(res.field_types)).toBe(true);
    expect(res.field_types.length).toBeGreaterThan(0);
  });
});
