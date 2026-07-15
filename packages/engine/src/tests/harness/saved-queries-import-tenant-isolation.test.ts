/**
 * Phase C — saved-queries + import-logs tenant isolation (campaign closure).
 *   - zv_saved_queries: `is_shared` was GLOBAL, so a query shared in tenant B was
 *     visible to tenant A. Sharing must be per-ORGANIZATION → scoped by tenant_id.
 *   - zv_import_logs: the list handler only narrowed to created_by for non-admins,
 *     so a tenant admin saw every tenant's import logs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';
const STAMP = Date.now();
const FOREIGN_SQ_ID = '00000000-0000-4000-8000-0000000000d1';
const FOREIGN_LOG_ID = '00000000-0000-4000-8000-0000000000d2';

d('saved-queries/import tenant isolation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    // Another tenant's SHARED saved query — must NOT surface to this tenant.
    await db
      .insertInto('zv_saved_queries')
      .values({
        id: FOREIGN_SQ_ID,
        name: `foreign-shared-${STAMP}`,
        collection: 'anything',
        config: JSON.stringify({ filters: [] }),
        is_shared: true,
        created_by: null,
        tenant_id: OTHER_TENANT,
      } as never)
      .execute();

    // Another tenant's import log.
    await db
      .insertInto('zv_import_logs')
      .values({
        id: FOREIGN_LOG_ID,
        collection: 'anything',
        filename: `foreign-${STAMP}.csv`,
        file_format: 'csv',
        status: 'completed',
        created_by: null,
        tenant_id: OTHER_TENANT,
      } as never)
      .execute();
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zv_saved_queries')
      .where('id', '=', FOREIGN_SQ_ID)
      .execute()
      .catch(() => {});
    await db
      .deleteFrom('zv_import_logs')
      .where('id', '=', FOREIGN_LOG_ID)
      .execute()
      .catch(() => {});
  });

  it('saved-queries: another org’s SHARED query is not visible (per-org sharing)', async () => {
    const list = await app.request('/api/saved-queries', { headers: { cookie } });
    expect(list.status).toBe(200);
    const ids = ((await list.json()) as { queries: { id: string }[] }).queries.map((q) => q.id);
    expect(ids).not.toContain(FOREIGN_SQ_ID);
  });

  it('saved-queries: GET /:id of another org’s query → 404', async () => {
    const res = await app.request(`/api/saved-queries/${FOREIGN_SQ_ID}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('import: another tenant’s import logs are not listed', async () => {
    const res = await app.request('/api/import/jobs', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs?: { id: string }[]; logs?: { id: string }[] };
    const ids = (body.jobs ?? body.logs ?? []).map((j) => j.id);
    expect(ids).not.toContain(FOREIGN_LOG_ID);
  });
});
