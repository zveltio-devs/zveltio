/**
 * ADR 0034: an extension route's `ctx.host(c).files`, as its caller.
 *
 * `put` and `delete` run `/api/storage`'s own path (`lib/stored-files.ts`) for
 * the request's user or key, in the request's transaction, through the engine's
 * `/ext/*` chain and storage driver on migration 115's per-user RLS. The bytes
 * follow the transaction: a put's go if the route throws, a delete's only once
 * the request commits. No files without `files`, without `$storage` for a key,
 * or on a public route.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ExtensionContext as SdkContext, ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { getStorage } from '../../lib/storage/index.js';
import { type FileActor, storeFile } from '../../lib/stored-files.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { toJsonb } from '../../lib/jsonb.js';
import {
  asEveryTenant,
  asTenant,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const EXT = `rfiles-ext-${STAMP}`;
const NOFILES = `rfiles-nofiles-${STAMP}`;

type Answer = { status: number; body: Record<string, unknown> | null; error?: string };

d("a route's host.files acts as its caller (ADR 0034)", () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let user: { cookie: string; userId: string };
  let colleague: { cookie: string; userId: string };
  const keys = { storage: '', storageId: '', bare: '' };

  async function load(ext: ZveltioExtension, manifest: Record<string, unknown>): Promise<void> {
    const parsed = ManifestSchema.parse({ name: ext.name, version: '1.0.0', ...manifest });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${ext.name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${ext.name}, ${ext.name}, NULL, true, true, ${toJsonb(parsed)})
    `.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    const loader = {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
    await finalizeExtensionLoad(
      loader,
      ext,
      ext.name,
      `/tmp/${ext.name}`,
      app,
      ctx,
      parsed as never,
      new Set(),
    );
  }

  /** `put` the body, or `delete` `:id`; `?fail=1` throws after it, rolling the request back. */
  const extension = (name: string): ZveltioExtension => ({
    name,
    category: 'custom',
    mountStrategy: 'subapp',
    async register(r, sdk) {
      const ctx = sdk as SdkContext;
      const files = (c: Context) => ctx.host!(c).files!;
      const answer = (c: Context, fn: () => Promise<unknown>) =>
        fn().then(
          async (body) => {
            if (c.req.query('fail')) throw new Error('the route failed after the call');
            return c.json({ status: 200, body });
          },
          (e: { status?: number; message?: string }) =>
            c.json({ status: e.status ?? 418, body: null, error: e.message }),
        );
      const put = async (c: Context) =>
        answer(c, async () =>
          files(c).put(
            c.req.query('name') ?? 'note.txt',
            new Uint8Array(await c.req.arrayBuffer()),
          ),
        );
      (r as Hono).post('/priv/put', put);
      (r as Hono).post('/pub/put', put);
      (r as Hono).post('/priv/delete/:id', (c) =>
        answer(c, () => files(c).delete(c.req.param('id'))),
      );
    },
  });

  const call = async (
    ext: string,
    path: string,
    who: { cookie?: string; key?: string },
    body?: Uint8Array,
  ): Promise<{ http: number; answer: Answer | null }> => {
    const headers: Record<string, string> = {};
    if (who.cookie) headers.cookie = who.cookie;
    if (who.key) headers.authorization = `Bearer ${who.key}`;
    const res = await app.request(`/ext/${ext}${path}`, {
      method: 'POST',
      headers,
      body: body as BodyInit | undefined,
    });
    return {
      http: res.status,
      answer: res.status === 200 ? ((await res.json()) as Answer) : null,
    };
  };
  const row = (id: string) =>
    asEveryTenant(db, (trx) =>
      trx.selectFrom('zv_media_files').selectAll().where('id', '=', id).executeTakeFirst(),
    );
  const rowsNamed = (name: string) =>
    asEveryTenant(db, (trx) =>
      trx.selectFrom('zv_media_files').selectAll().where('original_name', '=', name).execute(),
    );
  const fixture = (u: string): FileActor => ({
    tenantId: DEFAULT_TENANT_ID,
    principalId: u,
    author: u,
    apiKeyRow: null,
    seesAll: false,
  });
  const make = async (u: string, shared = false) => {
    const r = await asTenant(db, DEFAULT_TENANT_ID, (trx) =>
      storeFile(trx, fixture(u), {
        name: 'made.txt',
        bytes: new Uint8Array(8).fill(7),
        isPublic: shared,
      }),
    );
    if (!('file' in r)) throw new Error(`fixture refused: ${r.body.error}`);
    return r.file;
  };
  const stored = async (path: string) =>
    (await getStorage()
      .get(path)
      .catch(() => null)) ?? null;

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    user = await createMemberSession(engine, db, {});
    colleague = await createMemberSession(engine, db, {});
    for (const [k, scopes] of [
      ['storage', [{ collection: '$storage', actions: ['create'] }]],
      ['bare', []],
    ] as const) {
      const raw = generateApiKey();
      const all = [{ collection: `$ext:${EXT}`, actions: ['create'] }, ...scopes];
      const r = await sql<{ id: string }>`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, created_by, is_active, tenant_id)
        VALUES (${`rfiles-${k}-${STAMP}`}, ${await hashApiKey(raw)}, ${raw.slice(0, 12)},
                ${JSON.stringify(all)}::jsonb, ${user.userId}, true, ${DEFAULT_TENANT_ID})
        RETURNING id`.execute(db);
      keys[k] = raw;
      if (k === 'storage') keys.storageId = r.rows[0]!.id;
    }

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    const manifest = { publicRoutes: ['/pub/*'], apiKeyRoutes: ['POST /priv/put'] };
    await load(extension(EXT), { ...manifest, permissions: ['files'] });
    await load(extension(NOFILES), manifest);
    invalidateActivationCache();
  }, 120_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    const users = [user?.userId, colleague?.userId].filter(Boolean) as string[];
    const files = await asEveryTenant(db, (trx) =>
      trx
        .selectFrom('zv_media_files')
        .select(['storage_path'])
        .where('created_by', 'in', users)
        .execute(),
    );
    for (const f of files) {
      await getStorage()
        .delete(f.storage_path)
        .catch(() => undefined);
    }
    await asEveryTenant(db, (trx) =>
      trx.deleteFrom('zv_media_files').where('created_by', 'in', users).execute(),
    );
    await sql`DELETE FROM zv_storage_quotas WHERE user_id = ${user?.userId ?? ''}`.execute(db);
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`rfiles-%-${STAMP}`}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${NOFILES})`.execute(db);
  });

  it("puts a private file of the caller's, in its tenant, with its bytes", async () => {
    const { answer } = await call(EXT, '/priv/put?name=put-ok.txt', user, new Uint8Array(5));
    expect(answer?.status, answer?.error).toBe(200);
    const id = String(answer!.body!.id);
    const r = await row(id);
    expect(r).toMatchObject({
      created_by: user.userId,
      created_by_api_key: null,
      visibility: 'personal',
      tenant_id: DEFAULT_TENANT_ID,
      original_name: 'put-ok.txt',
    });
    expect((await stored(r!.storage_path))?.bytes.byteLength).toBe(5);
  });

  it('removes the bytes of a put whose request rolls back', async () => {
    const driver = getStorage();
    const put = driver.put.bind(driver);
    const paths: string[] = [];
    driver.put = async (key, bytes, opts) => {
      paths.push(key);
      return put(key, bytes, opts);
    };
    try {
      const { http } = await call(
        EXT,
        '/priv/put?name=put-rolled.txt&fail=1',
        user,
        new Uint8Array(6),
      );
      expect(http).toBe(500);
    } finally {
      driver.put = put;
    }
    expect(await rowsNamed('put-rolled.txt')).toHaveLength(0);
    expect(paths).toHaveLength(1);
    expect(await stored(paths[0]!)).toBeNull();
  });

  it("refuses a put over the caller's quota (413)", async () => {
    await sql`INSERT INTO zv_storage_quotas (user_id, quota_bytes, used_bytes)
              VALUES (${user.userId}, 1, 0)`.execute(db);
    try {
      const { answer } = await call(EXT, '/priv/put?name=put-quota.txt', user, new Uint8Array(9));
      expect(answer?.status).toBe(413);
      expect(await rowsNamed('put-quota.txt')).toHaveLength(0);
    } finally {
      await sql`DELETE FROM zv_storage_quotas WHERE user_id = ${user.userId}`.execute(db);
    }
  });

  it('holds a key to its $storage scope and records the upload as its own', async () => {
    const refused = await call(
      EXT,
      '/priv/put?name=put-bare.txt',
      { key: keys.bare },
      new Uint8Array(3),
    );
    expect(refused.answer?.status).toBe(403);
    expect(refused.answer?.error).toContain('$storage');
    const ok = await call(
      EXT,
      '/priv/put?name=put-key.txt',
      { key: keys.storage },
      new Uint8Array(3),
    );
    expect(ok.answer?.status, ok.answer?.error).toBe(200);
    expect(await row(String(ok.answer!.body!.id))).toMatchObject({
      created_by: user.userId,
      created_by_api_key: keys.storageId,
      visibility: 'personal',
    });
  });

  it("deletes the caller's file, and its bytes only once the request commits", async () => {
    const kept = await make(user.userId);
    const rolled = await call(EXT, `/priv/delete/${kept.id}?fail=1`, user);
    expect(rolled.http).toBe(500);
    expect(await row(kept.id)).toBeDefined();
    expect((await stored(kept.storage_path))?.bytes.byteLength).toBe(8);

    const { answer } = await call(EXT, `/priv/delete/${kept.id}`, user);
    expect(answer?.status, answer?.error).toBe(200);
    expect(await row(kept.id)).toBeUndefined();
    expect(await stored(kept.storage_path)).toBeNull();
  });

  it("answers a colleague's private file 404 and a shared one 403, as /api/storage", async () => {
    const own = await make(colleague.userId);
    const shared = await make(colleague.userId, true);
    expect((await call(EXT, `/priv/delete/${own.id}`, user)).answer?.status).toBe(404);
    expect((await call(EXT, `/priv/delete/${shared.id}`, user)).answer?.status).toBe(403);
    expect(await row(own.id)).toBeDefined();
    expect(await row(shared.id)).toBeDefined();
  });

  it('has no files on a public route, nor without the files capability', async () => {
    const pub = await call(EXT, '/pub/put?name=put-pub.txt', user, new Uint8Array(2));
    expect(pub.answer?.status).toBe(403);
    const none = await call(NOFILES, '/priv/put?name=put-none.txt', user, new Uint8Array(2));
    expect(none.answer?.status).toBe(403);
    expect(none.answer?.error).toContain('"files" capability');
    expect(await rowsNamed('put-pub.txt')).toHaveLength(0);
    expect(await rowsNamed('put-none.txt')).toHaveLength(0);
  });
});
