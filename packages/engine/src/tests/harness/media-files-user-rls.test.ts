/**
 * A colleague's personal file is kept out by the database, not only by the
 * route that remembered `lib/media-visibility.ts`.
 *
 * `zv_media_files` was policed for the tenant alone (023). Who inside the
 * tenant may see a row — its uploader, everyone for `visibility = 'tenant'`, a
 * tenant admin — lived only in the application, so any statement that skipped
 * the helper read every personal file of the firm. Measured before migration
 * 115: a member's request transaction listed a colleague's personal file, and
 * deleted the colleague's shared one. `storage/cloud`'s drive listing is such a
 * statement.
 *
 * The probe below is that statement: a route that reads and writes the table
 * in the request transaction with no check of its own, as a member, the owner
 * and a tenant admin.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { publishApiKeyActor } from '../../lib/tenancy/tenant-context.js';
import { withTenantIsolation } from '../../lib/tenancy/tenant-manager.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import {
  asEveryTenant,
  asKeyIssuer,
  asTenant,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const STAMP = `murls-${Date.now()}`;
const PROBE = `/api/${STAMP}`;

type Probe = {
  seen: string[];
  used: string;
  deleted: string[] | { errno: string };
  updated: string[] | { errno: string };
  inserted: string[] | { errno: string };
};

/** Run `run` and undo it, reporting what it returned or the SQLSTATE it raised. */
async function undone(trx: Database, run: () => Promise<{ id: string }[]>) {
  await sql`SAVEPOINT probe`.execute(trx);
  try {
    return (await run()).map((r) => r.id);
  } catch (err) {
    return { errno: String((err as { errno?: string }).errno ?? err) };
  } finally {
    await sql`ROLLBACK TO SAVEPOINT probe`.execute(trx);
  }
}

d('zv_media_files is policed per user inside the tenant', () => {
  let app: Hono;
  let db: Database;
  const probeApp = new Hono();
  const owner = { cookie: '', userId: '' };
  const colleague = { cookie: '', userId: '' };
  const admin = { cookie: '', userId: '' };
  let personal = '';
  let shared = '';

  const seed = (visibility: 'personal' | 'tenant', size = 1) =>
    asTenant(db, ROOT, (trx) =>
      trx
        .insertInto('zv_media_files')
        .values({
          tenant_id: ROOT,
          filename: STAMP,
          original_name: `${STAMP}.txt`,
          mimetype: 'text/plain',
          storage_path: `harness/${STAMP}-${crypto.randomUUID()}`,
          size,
          visibility,
          created_by: owner.userId,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow(),
    ).then((r) => r.id);

  const probe = async (cookie: string): Promise<Probe> => {
    const res = await probeApp.request(PROBE, { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as Probe;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    Object.assign(owner, await createMemberSession(app, db));
    Object.assign(colleague, await createMemberSession(app, db));
    Object.assign(admin, await createMemberSession(app, db));
    await asKeyIssuer(admin.userId);
    personal = await seed('personal');
    shared = await seed('tenant');
    // Trashed: given back to the quota.
    await asTenant(db, ROOT, (trx) =>
      sql`INSERT INTO zv_media_files
            (tenant_id, filename, original_name, mimetype, storage_path, size, visibility, created_by, deleted_at)
          VALUES (${ROOT}::uuid, ${`${STAMP}-gone`}, 'gone.txt', 'text/plain', ${`harness/${STAMP}-gone`},
                  100, 'personal', ${owner.userId}, now())`.execute(trx),
    );

    // A handler that forgot the media rule: no `applyFileVisibility`, no
    // `mayDeleteFile`, the request transaction as the engine's middleware opens it.
    probeApp.use('/api/*', sessionPrefetch(getAuth(), db));
    probeApp.use('/api/*', tenantMiddleware);
    probeApp.get(PROBE, async (c) => {
      const trx = c.get('tenantTrx') as Database;
      const seen = await trx
        .selectFrom('zv_media_files')
        .select('id')
        .where('filename', '=', STAMP)
        .orderBy('id')
        .execute();
      const deleted = await undone(trx, () =>
        trx.deleteFrom('zv_media_files').where('id', '=', shared).returning('id').execute(),
      );
      const updated = await undone(trx, () =>
        trx
          .updateTable('zv_media_files')
          .set({ original_name: 'renamed' })
          .where('id', '=', personal)
          .returning('id')
          .execute(),
      );
      const inserted = await undone(trx, () =>
        trx
          .insertInto('zv_media_files')
          .values({
            tenant_id: ROOT,
            filename: STAMP,
            original_name: 'forged',
            mimetype: 'text/plain',
            storage_path: `harness/${STAMP}-forged`,
            visibility: 'personal',
            created_by: owner.userId,
          } as never)
          .returning('id')
          .execute(),
      );
      // The quota's sum, which the caller's own view does not bound.
      const used = await sql<{ n: string }>`
        SELECT zveltio_media_used_bytes(${ROOT}::uuid, ${owner.userId}) AS n`.execute(trx);
      return c.json({
        seen: seen.map((r) => r.id),
        deleted,
        updated,
        inserted,
        used: used.rows[0]?.n,
      });
    });
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_media_files WHERE filename LIKE ${`${STAMP}%`}`.execute(trx),
    );
    await sql`DELETE FROM zv_api_keys WHERE name = ${STAMP}`.execute(db);
    await sql`DELETE FROM zv_storage_quotas WHERE user_id = ${admin.userId}`.execute(db);
  });

  it("hides a colleague's personal file from a member, and refuses writing it", async () => {
    const p = await probe(colleague.cookie);
    expect(p.seen).toEqual([shared]);
    // Reading the shared file is not owning it: no delete, as `mayDeleteFile`.
    expect(p.deleted).toEqual([]);
    expect(p.updated).toEqual([]);
    // Nor a row recorded as someone else's upload.
    expect(p.inserted).toEqual({ errno: '42501' });
    // The quota still counts every live byte of the owner's, trash aside.
    expect(Number(p.used)).toBe(2);
  });

  it('leaves the owner every one of their files', async () => {
    const p = await probe(owner.cookie);
    expect(p.seen).toEqual([personal, shared].sort());
    expect(p.deleted).toEqual([shared]);
    expect(p.updated).toEqual([personal]);
    expect((p.inserted as string[]).length).toBe(1);
  });

  it('leaves a tenant admin every file of the tenant', async () => {
    const p = await probe(admin.cookie);
    expect(p.seen).toEqual([personal, shared].sort());
    expect(p.deleted).toEqual([shared]);
    expect(p.updated).toEqual([personal]);
  });

  it("leaves the engine's own work, which names no actor, every file", async () => {
    // Background jobs, the trash purge, a public share link: a transaction
    // opened with no identity.
    const ids = await withTenantIsolation(ROOT, (trx) =>
      trx.selectFrom('zv_media_files').select('id').where('filename', '=', STAMP).execute(),
    );
    expect(ids.map((r) => r.id).sort()).toEqual([personal, shared].sort());
  });

  it('gives an extension job no personal file, not even its author’s (ADR 0028 decision 4)', async () => {
    const seen = (author: string) =>
      withTenantIsolation(ROOT, async (trx) => {
        await publishApiKeyActor('apikey:job:probe:files', false, [], undefined, '', undefined, {
          id: author,
          email: '',
        });
        const rows = await trx
          .selectFrom('zv_media_files')
          .select('id')
          .where('filename', '=', STAMP)
          .execute();
        return rows.map((r) => r.id).sort();
      });
    expect(await seen(owner.userId)).toEqual([shared]);
    expect(await seen(colleague.userId)).toEqual([shared]);
  });

  it("counts a key's uploads against its issuer's whole usage, private files included", async () => {
    // The quota sums the issuer's files; the key itself may see only what it
    // uploaded. Counted under the key's own view, the issuer's private bytes
    // vanished from the sum and the key wrote past the quota.
    await asTenant(db, ROOT, (trx) =>
      trx
        .insertInto('zv_media_files')
        .values({
          tenant_id: ROOT,
          filename: `${STAMP}-quota`,
          original_name: `${STAMP}-big.txt`,
          mimetype: 'text/plain',
          storage_path: `harness/${STAMP}-big`,
          size: 990,
          visibility: 'personal',
          created_by: admin.userId,
        } as never)
        .execute(),
    );
    await sql`INSERT INTO zv_storage_quotas (user_id, quota_bytes) VALUES (${admin.userId}, 1000)`.execute(
      db,
    );
    const raw = generateApiKey();
    await sql`
      INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
      VALUES (${STAMP}, ${await hashApiKey(raw)}, ${raw.slice(0, 12)},
              ${JSON.stringify([{ collection: '$storage', actions: ['read', 'create', 'delete'] }])}::jsonb,
              true, ${ROOT}::uuid, ${admin.userId})`.execute(db);
    const fd = new FormData();
    fd.set('file', new File(['x'.repeat(64)], 'over.txt', { type: 'text/plain' }));
    const res = await app.request('/api/storage/upload', {
      method: 'POST',
      headers: { 'X-API-Key': raw },
      body: fd,
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { detail: string }).detail).toBe('Storage quota exceeded');
  });
});
