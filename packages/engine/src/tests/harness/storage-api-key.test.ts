/**
 * `/api/storage` takes an API key holding the `$storage` scope.
 *
 * It was session-only: a valid key got 403 "Session required" on every
 * endpoint, so a program could not upload or fetch a file at all. The key is
 * held to the data path's model (`guardSessionOrKey` in lib/admin-guard.ts):
 * the scope must be named — a `*` data key does not reach storage — and a key
 * owns only what it uploaded (`created_by_api_key`, migration 021), so another
 * person's private file stays hidden unless the key carries `rls_bypass`, which
 * stands where a tenant admin does for a session.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TMP = mkdtempSync(join(tmpdir(), 'zv-key-store-'));
const ROOT = '00000000-0000-0000-0000-000000000001';
const TENANT = crypto.randomUUID();
const SLUG = `kstor-${TENANT.slice(0, 8)}`;
const STAMP = `kstor-${Date.now()}`;

type Scope = { collection: string; actions: string[] };
const STORAGE_ALL: Scope[] = [{ collection: '$storage', actions: ['read', 'create', 'delete'] }];
const KEYS: Record<string, { scopes: Scope[]; tenant: string; active?: false; bypass?: true }> = {
  data: { scopes: [{ collection: '*', actions: ['*'] }], tenant: ROOT },
  read: { scopes: [{ collection: '$storage', actions: ['read'] }], tenant: ROOT },
  write: { scopes: STORAGE_ALL, tenant: ROOT },
  bypass: { scopes: STORAGE_ALL, tenant: ROOT, bypass: true },
  doomed: { scopes: STORAGE_ALL, tenant: ROOT },
  revoked: { scopes: STORAGE_ALL, tenant: ROOT, active: false },
  tenant: { scopes: STORAGE_ALL, tenant: TENANT },
};
const raw: Record<string, string> = {};
const keyIds: Record<string, string> = {};

d('storage with an API key', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let issuer = '';
  const files: Record<string, string> = {};

  const seed = async (tenant: string, visibility: string, createdBy: string | null) => {
    const row = await db
      .insertInto('zv_media_files')
      .values({
        tenant_id: tenant,
        filename: `${STAMP}-${visibility}`,
        original_name: `${STAMP}.txt`,
        mimetype: 'text/plain',
        storage_path: `harness/${STAMP}-${crypto.randomUUID()}`,
        visibility,
        created_by: createdBy,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  };

  const as = (key: string | null, path: string, init: RequestInit = {}, slug?: string) =>
    app.request(path, {
      ...init,
      headers: {
        ...(key ? { 'X-API-Key': raw[key]! } : {}),
        ...(slug ? { 'X-Tenant-Slug': slug } : {}),
        ...(init.headers as Record<string, string>),
      },
    });

  const upload = (key: string, name = 'note.txt') => {
    const fd = new FormData();
    fd.set('file', new File(['hello'], name, { type: 'text/plain' }));
    return as(key, '/api/storage/upload', { method: 'POST', body: fd });
  };

  const listed = async (key: string, slug?: string) => {
    const res = await as(key, '/api/storage', {}, slug);
    expect(res.status).toBe(200);
    return ((await res.json()) as { files: { id: string }[] }).files.map((f) => f.id);
  };

  beforeAll(async () => {
    process.env.STORAGE_LOCAL_DIR = TMP;
    delete process.env.STORAGE_DRIVER;
    ({ app, db } = await getTestApp());
    const member = await createMemberSession(app, db);
    cookie = member.cookie;
    issuer = member.userId;
    const colleague = (await createMemberSession(app, db)).userId;
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${TENANT}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    for (const [name, k] of Object.entries(KEYS)) {
      raw[name] = generateApiKey();
      await sql`
        INSERT INTO zv_api_keys
          (name, key_hash, key_prefix, scopes, is_active, rls_bypass, tenant_id, created_by)
        VALUES (${`${STAMP}-${name}`}, ${await hashApiKey(raw[name]!)}, ${raw[name]!.slice(0, 12)},
                ${JSON.stringify(k.scopes)}::jsonb, ${k.active ?? true}, ${k.bypass ?? false},
                ${k.tenant}::uuid, ${issuer})
      `.execute(db);
      keyIds[name] = (
        await db
          .selectFrom('zv_api_keys')
          .select('id')
          .where('name', '=', `${STAMP}-${name}`)
          .executeTakeFirstOrThrow()
      ).id;
    }
    files.shared = await seed(ROOT, 'tenant', colleague);
    files.private = await seed(ROOT, 'personal', colleague);
    files.foreign = await seed(TENANT, 'tenant', colleague);
  }, 60_000);

  afterAll(async () => {
    rmSync(TMP, { recursive: true, force: true });
    if (!db) return;
    await sql`DELETE FROM zv_media_files WHERE original_name = ${`${STAMP}.txt`}
              OR created_by = ${issuer}`.execute(db);
    await sql`DELETE FROM zv_media_folders WHERE name = ${STAMP}`.execute(db);
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${STAMP}-%`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${TENANT}::uuid`.execute(db);
  });

  it('refuses a key without the $storage scope with 403 — a `*` data key included', async () => {
    expect((await as('data', '/api/storage')).status).toBe(403);
    expect((await upload('data')).status).toBe(403);
  });

  it('answers 401 to nobody, a revoked key and another tenant’s key', async () => {
    expect((await as(null, '/api/storage')).status).toBe(401);
    expect((await as('revoked', '/api/storage')).status).toBe(401);
    // A tenant key used in the root tenant is not a principal here.
    expect((await as('tenant', '/api/storage')).status).toBe(401);
  });

  it('lets a read key list and fetch, but not upload or delete', async () => {
    const ids = await listed('read');
    expect(ids).toContain(files.shared);
    // The key owns nothing: a colleague's private file stays hidden.
    expect(ids).not.toContain(files.private);
    expect(ids).not.toContain(files.foreign);
    expect((await as('read', `/api/storage/${files.shared}`)).status).toBe(200);
    expect((await as('read', `/api/storage/${files.private}`)).status).toBe(404);
    expect((await upload('read')).status).toBe(403);
    expect((await as('read', `/api/storage/${files.shared}`, { method: 'DELETE' })).status).toBe(
      403,
    );
  });

  it('lets a write key upload, recorded as its issuer and owned by the key', async () => {
    const res = await upload('write');
    expect(res.status).toBe(201);
    const { file } = (await res.json()) as {
      file: { id: string; created_by: string; created_by_api_key: string; tenant_id: string };
    };
    expect(file.created_by).toBe(issuer);
    expect(file.created_by_api_key).toBe(keyIds.write);
    expect(file.tenant_id).toBe(ROOT);
    // The key finds its private upload again; another key of the same issuer
    // does not, and the issuer's own session still does.
    expect(await listed('write')).toContain(file.id);
    expect((await as('write', `/api/storage/${file.id}`)).status).toBe(200);
    expect(await listed('read')).not.toContain(file.id);
    expect((await as('read', `/api/storage/${file.id}`)).status).toBe(404);
    const session = await app.request('/api/storage', { headers: { cookie } });
    const sessionIds = ((await session.json()) as { files: { id: string }[] }).files.map(
      (f) => f.id,
    );
    expect(sessionIds).toContain(file.id);
    expect((await as('write', `/api/storage/${file.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('lets a bypass key see and delete what other keys uploaded', async () => {
    const { file } = (await (await upload('write')).json()) as { file: { id: string } };
    // `rls_bypass` is the key's exemption, where a tenant admin's session has one.
    expect(await listed('bypass')).toContain(file.id);
    expect(await listed('bypass')).toContain(files.private);
    expect((await as('bypass', `/api/storage/${file.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('keeps the file, owned by its issuer alone, when the key row is deleted', async () => {
    const { file } = (await (await upload('doomed')).json()) as { file: { id: string } };
    await sql`DELETE FROM zv_api_keys WHERE id = ${keyIds.doomed}::uuid`.execute(db);
    const row = await db
      .selectFrom('zv_media_files')
      .select(['created_by', 'created_by_api_key'])
      .where('id', '=', file.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ created_by: issuer, created_by_api_key: null });
  });

  it('records a folder a key creates against its issuer', async () => {
    const res = await as('write', '/api/storage/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: STAMP }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { folder: { created_by: string } }).folder.created_by).toBe(
      issuer,
    );
  });

  it('shows a tenant key its own tenant’s files only', async () => {
    const ids = await listed('tenant', SLUG);
    expect(ids).toContain(files.foreign);
    expect(ids).not.toContain(files.shared);
    expect((await as('tenant', `/api/storage/${files.shared}`, {}, SLUG)).status).toBe(404);
  });

  it('keeps a root key’s own upload inside the tenant it was made in', async () => {
    // A root key acts in every tenant; owning the file must not carry it across.
    const { file } = (await (await upload('write')).json()) as { file: { id: string } };
    expect(await listed('write', SLUG)).not.toContain(file.id);
    expect((await as('write', `/api/storage/${file.id}`, {}, SLUG)).status).toBe(404);
    const del = await as('write', `/api/storage/${file.id}`, { method: 'DELETE' }, SLUG);
    expect(del.status).toBe(404);
    expect((await as('write', `/api/storage/${file.id}`)).status).toBe(200);
  });

  it('leaves a session as it was', async () => {
    const res = await app.request('/api/storage', { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});
