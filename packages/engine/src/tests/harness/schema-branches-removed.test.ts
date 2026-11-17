/**
 * Schema branches are gone (ADR 0049 slice 4): the schema changes through
 * `zveltio schema apply`, and the branch is git.
 *
 * Every `/api/schema/branches` route answers 410 naming the ADR. A request to
 * the data API still carrying `X-Preview-Token` is refused the same way: the
 * token used to move it onto a branch's schema, and ignored it would read and
 * write the live tables instead. `zv_schema_branches` is kept one release.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('schema branches are removed (ADR 0049)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  const gone = async (res: Response) => {
    expect(res.status).toBe(410);
    expect(((await res.json()) as { detail: string }).detail).toContain('ADR 0049');
  };

  it('/api/schema/branches answers 410 to god', async () => {
    await gone(await app.request('/api/schema/branches', { headers: { cookie } }));
    for (const path of ['/api/schema/branches', '/api/schema/branches/x/merge']) {
      await gone(
        await app.request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie },
          body: JSON.stringify({ name: 'b' }),
        }),
      );
    }
  });

  it('a data request carrying a preview token is refused, not served from public', async () => {
    const path = '/api/data/zv_no_such_collection';
    await gone(await app.request(path, { headers: { cookie, 'X-Preview-Token': 'zvp_x' } }));
    // Without the header the same request reaches the data API.
    expect((await app.request(path, { headers: { cookie } })).status).not.toBe(410);
  });

  it('zv_schema_branches stays one release', async () => {
    const r = await sql<{ t: string | null }>`
      SELECT to_regclass('public.zv_schema_branches')::text AS t`.execute(db);
    expect(r.rows[0]?.t).toBe('zv_schema_branches');
  });
});
