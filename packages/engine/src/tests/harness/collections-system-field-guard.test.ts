/**
 * Regression — `search_text` is a physical system column (the FTS trigger owns
 * it), but the collections routes kept their own copy of the reserved-name list
 * and that copy was missing it. A collection could therefore be created with a
 * user field named `search_text`; the value was then concatenated over by the
 * trigger on every write and stripped from every response — silent data loss.
 *
 * Both lists now come from `SYSTEM_COLUMNS`, and DELETE /:name/fields/:field
 * checks it too (it was the only one of the three field routes without a guard).
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('collections reject system column names (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  it('POST /api/collections refuses a field named search_text', async () => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `hsg_${Date.now()}`,
        fields: [
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
          { name: 'search_text', type: 'text', required: false, unique: false, indexed: false },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /:name/fields/:field refuses a system column name', async () => {
    const res = await app.request('/api/collections/zvd_nonexistent/fields/search_text', {
      method: 'DELETE',
      headers: { cookie },
    });
    // 400 (reserved) must win over the 404 the collection lookup would give.
    expect(res.status).toBe(400);
  });
  // The collection does not exist, so without the guard these answer 404.
  it('POST /:name/fields refuses a system column name', async () => {
    const res = await app.request('/api/collections/hsg_nonexistent/fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'tenant_id',
        type: 'text',
        required: false,
        unique: false,
        indexed: false,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /:name/fields/:field refuses renaming to or from a system column name', async () => {
    const patch = (field: string, newName: string) =>
      app.request(`/api/collections/hsg_nonexistent/fields/${field}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ new_name: newName }),
      });
    expect((await patch('search_text', 'renamed')).status).toBe(400);
    expect((await patch('title', 'tenant_id')).status).toBe(400);
  });
});
