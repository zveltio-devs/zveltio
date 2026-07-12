/**
 * Phase C — POST /api/collections/preview with computed field (routes + previewCollection).
 */

import { describe, expect, it, beforeAll } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('collections preview computed (in-process)', () => {
  let app: Hono;
  let _db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db: _db } = await getTestApp());
    cookie = await createGodSession(app, _db);
  });

  it('POST /preview omits computed fields from CREATE TABLE SQL', async () => {
    const res = await app.request('/api/collections/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'preview_comp',
        fields: [
          { name: 'label', type: 'text', required: true, unique: false, indexed: false },
          { name: 'rollup', type: 'computed', required: false, unique: false, indexed: false },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sql: string[] };
    const joined = body.sql.join('\n');
    expect(joined).toContain('"label"');
    expect(joined).not.toContain('"rollup"');
  });
});
