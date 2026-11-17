/**
 * No caller-written SQL runs in the engine (ADR 0058 decision 1).
 *
 * RLS reads the `zveltio.*` settings, and SQL in the same transaction can
 * rewrite them. On 3.0.0-beta.124 the root tenant's admin sent
 * `SELECT set_config('zveltio.current_tenant', '<other firm>', true),
 * query_to_xml('select name from zv_dashboards', …)` to `/api/insights/query`
 * and got the other firm's dashboards back (200). `/api/admin/sql` ran the
 * caller's SQL as the engine's own role, past RLS by construction. Both now
 * answer 410 naming the ADR; the insights tables are kept one release (ADR 0051).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  asEveryTenant,
  asTenant,
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER = '00000000-0000-0000-0000-0000000000fe';
const MARK = `caller-sql-${Date.now()}`;

d('caller-written SQL is gone (ADR 0058 d1)', () => {
  let app: Hono;
  let db: Database;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${MARK}, ${MARK}, 'active')
              ON CONFLICT (id) DO NOTHING`.execute(db);
    await asTenant(db, OTHER, (t) =>
      t
        .insertInto('zv_dashboards')
        .values({ name: MARK, is_public: false, tenant_id: OTHER })
        .execute(),
    );
  });

  afterAll(async () => {
    if (!db) return;
    await asEveryTenant(db, (t) =>
      t.deleteFrom('zv_dashboards').where('name', '=', MARK).execute(),
    );
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  const post = (path: string, cookie: string, query: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ query }),
    });

  it('/api/insights answers 410 to an instance admin forging the tenant setting', async () => {
    const admin = await createMemberSession(app, db, {
      grants: [{ collection: 'admin', actions: ['*'] }],
      configWindow: true,
    });
    const forge = `SELECT set_config('zveltio.current_tenant', '${OTHER}', true) AS t,
                   query_to_xml('select name from zv_dashboards', true, false, '') AS x`;
    for (const path of [
      '/api/insights/query',
      '/api/insights/saved-queries',
      '/api/insights/dashboards',
    ]) {
      const res = await post(path, admin.cookie, forge);
      const text = await res.text();
      expect(res.status).toBe(410);
      expect(text).not.toContain(MARK);
      expect(JSON.parse(text).detail).toContain('ADR 0051');
    }
  });

  it('/api/admin/sql answers 410 to god', async () => {
    const god = await createGodSession(app, db);
    const res = await post('/api/admin/sql', god, 'SELECT 1');
    expect(res.status).toBe(410);
    expect(((await res.json()) as { detail: string }).detail).toContain('ADR 0058');
  });

  it('the insights tables stay (ADR 0051: dropped a release later)', async () => {
    const rows = await asEveryTenant(db, (t) =>
      t.selectFrom('zv_dashboards').select('tenant_id').where('name', '=', MARK).execute(),
    );
    expect(rows).toEqual([{ tenant_id: OTHER }]);
  });
});
