/**
 * Phase C — storage/media routes must scope zv_media_files by tenant. Regression:
 * zv_media_files had no tenant_id / no RLS and the handlers queried by id only, so
 * any authenticated user could list/view/signed-URL/transform/DELETE another
 * tenant's files by id (cross-tenant IDOR). Migration 010 adds tenant_id; the
 * handlers now filter by the request's tenant.
 *
 * The harness runs as the default tenant (00000000-…-0001). We seed one file for
 * the default tenant and one for a foreign tenant, then assert the foreign file is
 * invisible/unmodifiable through both /api/storage and /api/media.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';

d('storage/media tenant isolation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let mineId = '';
  let theirsId = '';

  const seed = async (tenant: string, name: string): Promise<string> => {
    const row = await db
      .insertInto('zv_media_files')
      .values({
        tenant_id: tenant,
        filename: name,
        original_name: name,
        mimetype: 'text/plain',
        storage_path: `harness/${name}`,
      } as never)
      .returning('id')
      .executeTakeFirst();
    return (row as { id: string }).id;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    mineId = await seed(DEFAULT_TENANT, `mine_${Date.now()}`);
    theirsId = await seed(OTHER_TENANT, `theirs_${Date.now()}`);
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of [mineId, theirsId]) {
      await sql`DELETE FROM zv_media_files WHERE id = ${id}`.execute(db).catch(() => {});
    }
  });

  it('GET /api/storage/:id returns own file but 404s a foreign-tenant file', async () => {
    const mine = await app.request(`/api/storage/${mineId}`, { headers: { cookie } });
    expect(mine.status).toBe(200);
    const theirs = await app.request(`/api/storage/${theirsId}`, { headers: { cookie } });
    expect(theirs.status).toBe(404);
  });

  it('GET /api/storage/ lists only the current tenant files', async () => {
    const res = await app.request('/api/storage', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { id: string }[] };
    const ids = body.files.map((f) => f.id);
    expect(ids).toContain(mineId);
    expect(ids).not.toContain(theirsId);
  });

  it('DELETE /api/storage/:id cannot delete a foreign-tenant file', async () => {
    const res = await app.request(`/api/storage/${theirsId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
    const still = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_media_files WHERE id = ${theirsId}
    `.execute(db);
    expect(still.rows[0]!.n).toBe(1);
  });

  it('GET /api/media/files/:id 404s a foreign-tenant file', async () => {
    const res = await app.request(`/api/media/files/${theirsId}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('POST /api/media/files/batch-delete cannot trash a foreign-tenant file', async () => {
    const res = await app.request('/api/media/files/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ ids: [theirsId] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(0); // foreign file not trashed
    const foreign = await sql<{ deleted_at: string | null }>`
      SELECT deleted_at FROM zv_media_files WHERE id = ${theirsId}
    `.execute(db);
    expect(foreign.rows[0]?.deleted_at ?? null).toBeNull();
  });
});
