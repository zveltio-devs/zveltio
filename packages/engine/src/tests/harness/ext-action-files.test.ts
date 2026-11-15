/**
 * ADR 0052: an action reads and writes the files its request hands it.
 *
 * `host.files` of an action called over HTTP is bound to the request's `$files`
 * (ADR 0032) and nothing else: `read` of a handed id, one `put` under the handed
 * name and `maxBytes`, as the caller, the bytes following the request
 * transaction. The grant has one consumer: the action itself or one job. Through
 * the engine's own `/ext/*` chain and storage driver, on migration 115's RLS.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ActionHost, ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { unregisterJobs } from '../../lib/extensions/jobs.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { getStorage } from '../../lib/storage/index.js';
import { type FileActor, storeFile } from '../../lib/stored-files.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { toJsonb } from '../../lib/jsonb.js';
import {
  asEveryTenant,
  asTenant,
  createMemberSession,
  forgetRuleObjects,
  getTestApp,
  harnessAvailable,
  ruleObjects,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const RES = `actfiles_res_${STAMP}`;
const EXT = `actfiles-ext-${STAMP}`;
/** A dependency of EXT's, whose action EXT runs (ADR 0014). */
const DEP = `actfiles-dep-${STAMP}`;

type Outcome = { ok?: unknown; status?: number; code?: string; message?: string };

d('an action reads and writes the files its request hands it (ADR 0052)', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let user: { cookie: string; userId: string };
  let colleague: { cookie: string; userId: string };
  const made: Record<string, string> = {};

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

  /** What `fn` resolved to, or the refusal it threw, as the action answers it. */
  const outcome = async (fn: () => Promise<unknown>): Promise<Outcome> => {
    try {
      return { ok: await fn() };
    } catch (e) {
      const err = e as { status?: number; code?: string; message?: string };
      return { status: err.status, code: err.code, message: err.message };
    }
  };
  const id = (input: unknown) => (input as { id: string }).id;
  const read = async (input: unknown, host: ActionHost) => {
    const f = await host.files!.read(id(input));
    return { name: f.name, size: f.bytes.byteLength, byte: f.bytes[0] };
  };

  const act = async (ext: string, action: string, body: unknown, cookie = user.cookie) => {
    const res = await app.request(`/ext/${ext}/actions/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { result?: unknown } | null;
    return { status: res.status, result: json?.result as unknown };
  };
  const rowsNamed = (name: string) =>
    asEveryTenant(db, (trx) =>
      trx.selectFrom('zv_media_files').selectAll().where('original_name', '=', name).execute(),
    );
  const stored = async (path: string) =>
    (await getStorage()
      .get(path)
      .catch(() => null)) ?? null;
  const make = async (u: string, fill: number) => {
    const actor: FileActor = {
      tenantId: DEFAULT_TENANT_ID,
      principalId: u,
      author: u,
      apiKeyRow: null,
      seesAll: false,
    };
    const r = await asTenant(db, DEFAULT_TENANT_ID, (trx) =>
      storeFile(trx, actor, { name: 'made.txt', bytes: new Uint8Array(6).fill(fill) }),
    );
    if (!('file' in r)) throw new Error(`fixture refused: ${r.body.error}`);
    return r.file.id;
  };

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    await ruleObjects(db, RES);
    _setInlineForTests(true);
    const run = { collection: RES, actions: ['execute'] };
    user = await createMemberSession(engine, db, { grants: [run] });
    colleague = await createMemberSession(engine, db, { grants: [run] });
    made.handed = await make(user.userId, 11);
    made.unhanded = await make(user.userId, 22);
    made.colleagues = await make(colleague.userId, 33);

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    const action = (name: string, more: Record<string, unknown> = {}) => ({
      name,
      permission: { resource: RES },
      input: { type: 'object' },
      ...more,
    });
    const noop = async () => {};
    await load(
      {
        name: DEP,
        category: 'custom',
        mountStrategy: 'subapp',
        actions: { read: (input, host) => outcome(() => read(input, host)) },
        async register() {},
      },
      { permissions: ['files'], resources: [RES], actions: [action('read')] },
    );
    await load(
      {
        name: EXT,
        category: 'custom',
        mountStrategy: 'subapp',
        actions: {
          read: (input, host) => outcome(() => read(input, host)),
          put: async (input, host) => {
            const out: Outcome[] = [];
            for (const n of (input as { sizes: number[] }).sizes) {
              out.push(await outcome(() => host.files!.put(new Uint8Array(n).fill(66))));
            }
            return out;
          },
          putThenFail: async (_input, host) => {
            await host.files!.put(new Uint8Array(3).fill(67));
            throw new Error('the action failed after its put');
          },
          readThenEnqueue: async (input, host) => ({
            read: await outcome(() => read(input, host)),
            enqueue: await outcome(() => host.enqueue('noop', {}, { files: true })),
          }),
          enqueueThenRead: async (input, host) => {
            await host.enqueue('noop', {}, { files: true });
            return outcome(() => read(input, host));
          },
          relay: (input, host) => host.actions!.run(DEP, 'read', input),
          readEach: async (input, host) => {
            const out: Outcome[] = [];
            for (const id of (input as { ids: string[] }).ids) {
              out.push(await outcome(() => read({ id }, host)));
            }
            return out;
          },
        },
        jobs: { noop },
        async register() {},
      },
      {
        permissions: ['data:system', 'files'],
        resources: [RES],
        dependencies: [{ name: DEP }],
        actions: [
          action('read'),
          action('put'),
          action('putThenFail'),
          action('readThenEnqueue', { enqueues: ['noop'] }),
          action('enqueueThenRead', { enqueues: ['noop'] }),
          action('relay', { calls: [`${DEP}.read`] }),
          action('readEach'),
        ],
        jobs: [{ name: 'noop', input: { type: 'object' }, retry: { limit: 0 } }],
      },
    );
    invalidateActivationCache();
  }, 120_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    await forgetRuleObjects(db, RES);
    for (const e of [EXT, DEP]) await unregisterJobs(e);
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
    await sql`DELETE FROM pgboss.job WHERE name LIKE ${'ext.actfiles-%'}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${DEP})`.execute(db);
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_audit_log WHERE resource_id LIKE ${'actfiles-%'}`.execute(trx),
    );
  });

  it('reads a handed file, with its bytes, as the caller', async () => {
    const r = await act(EXT, 'read', { id: made.handed, $files: { read: [made.handed] } });
    expect(r.status).toBe(200);
    expect(r.result).toEqual({ ok: { name: 'made.txt', size: 6, byte: 11 } });
  });

  it('refuses an id the request did not hand, even one the caller may read', async () => {
    const r = await act(EXT, 'read', { id: made.unhanded, $files: { read: [made.handed] } });
    expect(r.result).toMatchObject({ status: 403, code: 'file_not_granted' });
    // A colleague's private file cannot be handed at all: the grant is checked first.
    const theirs = await act(EXT, 'read', {
      id: made.colleagues,
      $files: { read: [made.colleagues] },
    });
    expect(theirs.status).toBe(404);
  });

  it('reads at most one upload’s worth of bytes in all, however many ids were handed', async () => {
    const prev = process.env.MAX_UPLOAD_BYTES;
    process.env.MAX_UPLOAD_BYTES = '10'; // each fixture file is 6 bytes
    try {
      const ids = [made.handed, made.unhanded];
      const r = await act(EXT, 'readEach', { ids, $files: { read: ids } });
      expect(r.status).toBe(200);
      const [first, second] = r.result as Outcome[];
      expect(first).toMatchObject({ ok: { size: 6 } });
      expect(second).toMatchObject({ status: 413, code: 'file_too_large' });
    } finally {
      if (prev === undefined) delete process.env.MAX_UPLOAD_BYTES;
      else process.env.MAX_UPLOAD_BYTES = prev;
    }
  });

  it('has no files without $files, nor in an action another action ran', async () => {
    const none = await act(EXT, 'read', { id: made.handed });
    expect(none.result).toMatchObject({ status: 403, code: 'file_not_granted' });
    expect(String((none.result as Outcome).message)).toContain('carried no $files');
    const relayed = await act(EXT, 'relay', { id: made.handed, $files: { read: [made.handed] } });
    expect(relayed.result).toMatchObject({ status: 403, code: 'file_not_granted' });
    expect(String((relayed.result as Outcome).message)).toContain('run by another action');
  });

  it("puts one file under the handed name, within maxBytes, as the caller's own", async () => {
    const name = `put-${STAMP}.txt`;
    const r = await act(EXT, 'put', {
      sizes: [5, 4, 4],
      $files: { write: { name, maxBytes: 4 } },
    });
    expect(r.status).toBe(200);
    const [over, ok, again] = r.result as Outcome[];
    expect(over).toMatchObject({ status: 413, code: 'file_too_large' });
    expect(ok?.ok).toMatchObject({ name, size: 4 });
    expect(again).toMatchObject({ status: 409, code: 'file_already_put' });
    const rows = await rowsNamed(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: (ok?.ok as { id: string } | undefined)?.id,
      created_by: user.userId,
      created_by_api_key: null,
      visibility: 'personal',
      tenant_id: DEFAULT_TENANT_ID,
    });
    expect((await stored(rows[0]!.storage_path))?.bytes.byteLength).toBe(4);
    // No write grant, no put.
    const noWrite = await act(EXT, 'put', { sizes: [1], $files: { read: [made.handed] } });
    expect((noWrite.result as Outcome[])[0]).toMatchObject({ status: 403 });
  });

  it('leaves no file, row or bytes, when the action is refused after its put', async () => {
    const name = `rolled-${STAMP}.txt`;
    const driver = getStorage();
    const put = driver.put.bind(driver);
    const paths: string[] = [];
    driver.put = async (key, bytes, opts) => {
      paths.push(key);
      return put(key, bytes, opts);
    };
    try {
      const r = await act(EXT, 'putThenFail', { $files: { write: { name, maxBytes: 9 } } });
      expect(r.status).toBe(500);
    } finally {
      driver.put = put;
    }
    expect(await rowsNamed(name)).toHaveLength(0);
    expect(paths).toHaveLength(1);
    expect(await stored(paths[0]!)).toBeNull();
  });

  it('gives the grant to one consumer: the action or a job, not both', async () => {
    const files = { read: [made.handed] };
    const used = await act(EXT, 'readThenEnqueue', { id: made.handed, $files: files });
    expect(used.status).toBe(200);
    const { read: r, enqueue } = used.result as { read: Outcome; enqueue: Outcome };
    expect(r.ok).toMatchObject({ size: 6 });
    expect(enqueue.ok).toBeUndefined();
    expect(String(enqueue.message)).toContain("already used the request's $files");

    const passed = await act(EXT, 'enqueueThenRead', { id: made.handed, $files: files });
    expect(passed.status).toBe(200);
    expect(passed.result).toMatchObject({ status: 409, code: 'file_not_granted' });
    expect(String((passed.result as Outcome).message)).toContain('already went to a job');
  });
});
