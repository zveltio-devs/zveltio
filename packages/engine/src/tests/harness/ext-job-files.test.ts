/**
 * ADR 0032: a job reaches only the stored files its user hands it.
 *
 * The user hands them in the action request (`$files`), checked as the caller
 * before the action runs; the action passes them to one job with
 * `host.enqueue(job, input, { files: true })`; the job's `host.files.get` reads
 * only granted ids, each checked again as the enqueuer when it runs, and its one
 * `put` is bound to the granted name and size and recorded as the enqueuer's
 * upload. Through the engine's own `/ext/*` chain, queue and storage driver, on
 * migration 115's per-user RLS. The Deno half: the bytes cross the channel past
 * its 16 MiB, the per-call and per-run limits hold, and an egress job's retried
 * put answers the file its first attempt stored.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ActionHost, JobHost, ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { JOB_FILE_LIMITS } from '../../lib/extensions/file-grants.js';
import {
  compileJobs,
  jobQueueName,
  registerJobs,
  unregisterJobs,
  verifiedJobsCode,
} from '../../lib/extensions/jobs.js';
import { ensureDeno } from '../../lib/extensions/deno.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { DDLManager, jobQueue } from '../../lib/data/index.js';
import { getStorage } from '../../lib/storage/index.js';
import { type FileActor, servedAs, storeFile } from '../../lib/stored-files.js';
import { createRequestScopedDb, DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
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
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  forgetRuleObjects,
  ruleObjects,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `jobfiles_${STAMP}`;
const RES = `jobfiles_res_${STAMP}`;
/** Holds `files`; its actions hand files to its jobs. */
const EXT = `jobfiles-ext-${STAMP}`;
/** A dependency of EXT's, whose action EXT runs (ADR 0014). */
const DEP = `jobfiles-dep-${STAMP}`;
/** The same code, without `files`. */
const NOFILES = `jobfiles-nofiles-${STAMP}`;
/** Deno jobs, sent straight to the queue as `enqueue` writes them. */
const DENO = `jobfiles-deno-${STAMP}`;
const OTHER = crypto.randomUUID();
const SLUG = `jobfiles-${OTHER.slice(0, 8)}`;

type Probe = { tag: string; get?: string[]; put?: number[]; wait?: boolean; view?: boolean };

d('a job reaches only the stored files its user hands it (ADR 0032)', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let author: { cookie: string; userId: string };
  let colleague: { cookie: string; userId: string };
  /** Member keys the author issued: with `$storage` read+create, and with none. */
  const keys = { storage: '', storageId: '', bare: '', bareId: '' };
  /** Files made before the jobs run, as an upload makes them. */
  const made: Record<string, string> = {};
  /** A probe with `wait` holds until its tag is released. */
  const gates = new Map<string, { open: Promise<void>; release: () => void }>();
  const gate = (tag: string) => {
    let release = () => {};
    const open = new Promise<void>((r) => {
      release = r;
    });
    gates.set(tag, { open, release });
  };
  let extDir = '';

  function loader(ctx: ExtensionContext): ExtensionLoader {
    return {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
  }
  async function load(ext: ZveltioExtension, manifest: Record<string, unknown>): Promise<void> {
    const parsed = ManifestSchema.parse({ name: ext.name, ...manifest });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${ext.name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${ext.name}, ${ext.name}, NULL, true, true, ${toJsonb(parsed)})
    `.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    await finalizeExtensionLoad(
      loader(ctx),
      ext,
      ext.name,
      `/tmp/${ext.name}`,
      app,
      ctx,
      parsed as never,
      new Set(),
    );
  }

  const fail = (e: { status?: number; code?: string; message?: string }) =>
    `E${e.status ?? ''}:${e.code ?? e.message}`;
  /** The one inline job: tries what its input names, and records the outcomes. */
  const probe = async (input: unknown, host: JobHost) => {
    const i = input as Probe;
    if (i.wait) await gates.get(i.tag)?.open;
    const out: string[] = [];
    for (const id of i.get ?? []) {
      try {
        const f = await host.files!.get(id);
        out.push(f ? `read:${f.bytes.byteLength}` : 'null');
      } catch (e) {
        out.push(fail(e as never));
      }
    }
    for (const n of i.put ?? []) {
      try {
        out.push(`put:${(await host.files!.put(new Uint8Array(n).fill(65))).id}`);
      } catch (e) {
        out.push(fail(e as never));
      }
    }
    if (i.view) {
      // The job's own view, on its transaction, after the engine's reads and writes.
      const r = await sql<{ personal: string; actor: string }>`
        SELECT count(*) FILTER (WHERE visibility = 'personal') AS personal,
               current_setting('zveltio.actor', true) AS actor
          FROM zv_media_files`.execute(createRequestScopedDb(db));
      out.push(`view:${r.rows[0]?.personal}:${r.rows[0]?.actor}`);
    }
    await host.collections.insert(C, { label: ['probe', i.tag, ...out].join('|') });
  };
  const send = (input: unknown, host: ActionHost) =>
    host.enqueue(
      'probe',
      input,
      (input as { plain?: boolean }).plain ? undefined : { files: true },
    );
  const caught = async (fn: () => Promise<unknown>) => {
    try {
      return { ok: await fn() };
    } catch (e) {
      return { threw: (e as Error).message };
    }
  };

  const act = (
    ext: string,
    action: string,
    body: unknown,
    who: { cookie?: string; key?: string } = { cookie: author.cookie },
  ) =>
    app.request(`/ext/${ext}/actions/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(who.cookie ? { cookie: who.cookie } : {}),
        ...(who.key ? { 'x-api-key': who.key } : {}),
      },
      body: JSON.stringify(body),
    });
  const labels = async (prefix: string) =>
    asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<{ label: string }>`
            SELECT label FROM ${sql.table(`zvd_${C}`)} WHERE label LIKE ${`${prefix}%`}`.execute(
            trx,
          )
        ).rows,
    ).then((r) => r.map((x) => x.label));
  async function until<T>(probe: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const v = await probe();
      if (done(v)) return v;
      await Bun.sleep(100);
    }
    return probe();
  }
  /** What the probe tagged `tag` recorded. */
  const outcome = async (tag: string) => {
    const got = await until(
      () => labels(`probe|${tag}|`),
      (r) => r.length > 0,
    );
    return got[0]?.slice(`probe|${tag}|`.length) ?? '(no result)';
  };
  const queued = async (tag: string) =>
    Number(
      (
        await sql<{ n: string }>`SELECT count(*) AS n FROM pgboss.job
          WHERE name LIKE ${'ext.jobfiles-%'} AND data->'input'->>'tag' = ${tag}`.execute(db)
      ).rows[0]?.n,
    );
  const fixture = (tenantId: string, user: string): FileActor => ({
    tenantId,
    principalId: user,
    author: user,
    apiKeyRow: null,
    seesAll: false,
  });
  const make = async (tenantId: string, user: string, shared = false, size = 4) => {
    const r = await asTenant(db, tenantId, (trx) =>
      storeFile(trx, fixture(tenantId, user), {
        name: 'made.txt',
        bytes: new Uint8Array(size).fill(77),
        isPublic: shared,
      }),
    );
    if (!('file' in r)) throw new Error(`fixture refused: ${r.body.error}`);
    return r.file.id;
  };
  const row = (id: string) =>
    asEveryTenant(db, (trx) =>
      trx.selectFrom('zv_media_files').selectAll().where('id', '=', id).executeTakeFirst(),
    );
  const setFile = (id: string, set: { visibility?: 'personal'; deleted_at?: Date }) =>
    asEveryTenant(db, (trx) =>
      trx.updateTable('zv_media_files').set(set).where('id', '=', id).execute(),
    );
  const jobId = async (res: Response) => {
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: string }).result;
  };

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    await ruleObjects(db, RES);
    _setInlineForTests(true);
    await ensureDeno();
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ t: string | null }>`SELECT to_regclass(${`zvd_${C}`}) AS t`.execute(
        db,
      );
      if (seen.rows[0]?.t) break;
      await Bun.sleep(100);
    }
    const run = { collection: RES, actions: ['execute'] };
    author = await createMemberSession(engine, db, { grants: [run] });
    colleague = await createMemberSession(engine, db, { grants: [run] });
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    for (const [k, scopes] of [
      ['storage', [{ collection: '$storage', actions: ['read', 'create'] }]],
      ['bare', []],
    ] as const) {
      const raw = generateApiKey();
      const all = [{ collection: `$ext:${EXT}`, actions: ['execute'] }, ...scopes];
      const r = await sql<{ id: string }>`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, created_by, is_active, tenant_id)
        VALUES (${`jobfiles-${k}-${STAMP}`}, ${await hashApiKey(raw)}, ${raw.slice(0, 12)},
                ${JSON.stringify(all)}::jsonb, ${author.userId}, true, ${DEFAULT_TENANT_ID})
        RETURNING id`.execute(db);
      keys[k] = raw;
      keys[`${k}Id`] = r.rows[0]!.id;
    }
    made.colleaguePrivate = await make(DEFAULT_TENANT_ID, colleague.userId);
    made.colleagueShared = await make(DEFAULT_TENANT_ID, colleague.userId, true);
    made.ownPrivate = await make(DEFAULT_TENANT_ID, author.userId);
    made.ownShared = await make(DEFAULT_TENANT_ID, author.userId, true);
    made.otherTenant = await make(OTHER, author.userId);

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    const action = (name: string) => ({
      name,
      permission: { resource: RES },
      input: { type: 'object' },
      enqueues: ['probe'],
    });
    const probeJob = {
      name: 'probe',
      input: { type: 'object' },
      writes: [C],
      retry: { limit: 0 },
      fromPublicRoutes: ['/hook'],
    };
    await load(
      {
        name: DEP,
        category: 'custom',
        mountStrategy: 'subapp',
        actions: { send },
        jobs: { probe },
        async register() {},
      },
      {
        permissions: ['data:system', 'files'],
        resources: [RES],
        actions: [action('send')],
        jobs: [{ ...probeJob, fromPublicRoutes: [] }],
      },
    );
    for (const [name, permissions] of [
      [EXT, ['data:system', 'files']],
      [NOFILES, ['data:system']],
    ] as const) {
      await load(
        {
          name,
          category: 'custom',
          mountStrategy: 'subapp',
          actions: {
            send,
            badOptions: (input, host) =>
              caught(() =>
                host.enqueue('probe', input, {
                  files: { read: (input as { ids: string[] }).ids },
                } as never),
              ),
            twice: async (input, host) => {
              const first = await host.enqueue('probe', input, { files: true });
              return { first, second: await caught(() => send(input, host)) };
            },
            // The called action's `enqueue`: the request's grant is not its to pass on.
            relay: (input, host) => caught(() => host.actions!.run(DEP, 'send', input)),
            // `$files` in a called action's input.
            relayFiles: (input, host) =>
              host.actions!.run(DEP, 'send', {
                ...(input as object),
                $files: { read: (input as { ids: string[] }).ids },
              }),
          },
          jobs: { probe },
          async register(sub, ctx) {
            sub.post('/hook', async (c) =>
              c.json({
                id: await ctx.internals!.enqueue!(c as never, 'probe', await c.req.json()),
              }),
            );
          },
        },
        {
          permissions: [...permissions],
          resources: [RES],
          publicRoutes: ['/hook'],
          dependencies: [{ name: DEP }],
          actions: [
            action('send'),
            action('badOptions'),
            action('twice'),
            { ...action('relay'), calls: [`${DEP}.send`] },
            { ...action('relayFiles'), calls: [`${DEP}.send`] },
          ],
          jobs: [probeJob],
        },
      );
    }
    invalidateActivationCache();
  }, 180_000);

  afterAll(async () => {
    await forgetRuleObjects(db, RES);
    invalidateActivationCache();
    for (const e of [EXT, DEP, NOFILES, DENO]) await unregisterJobs(e);
    if (extDir) rmSync(extDir, { recursive: true, force: true });
    if (!db) return;
    const users = [author?.userId, colleague?.userId].filter(Boolean) as string[];
    const files = await asEveryTenant(db, (trx) =>
      trx
        .selectFrom('zv_media_files')
        .select(['id', 'storage_path'])
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
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`jobfiles-%-${STAMP}`}`.execute(db);
    await sql`DELETE FROM pgboss.job WHERE name LIKE ${'ext.jobfiles-%'}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${DEP}, ${NOFILES})`.execute(
      db,
    );
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_audit_log WHERE resource_id LIKE ${'jobfiles-%'}`.execute(trx),
    );
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_revisions WHERE collection = ${C}`.execute(trx),
    );
    await dropTestCollection(db, C);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  // Verified 1.
  it("refuses a colleague's private file, another tenant's and a missing one; queues nothing", async () => {
    const ids = [made.colleaguePrivate!, made.otherTenant!, crypto.randomUUID()];
    for (const [i, id] of ids.entries()) {
      const tag = `refused-${i}`;
      const res = await act(EXT, 'send', { tag, $files: { read: [made.colleagueShared, id] } });
      expect(res.status).toBe(404);
      expect(await queued(tag)).toBe(0);
    }
    const bad = async (files: unknown) =>
      (await act(EXT, 'send', { tag: 'bad', $files: files })).status;
    expect(await bad({ read: Array.from({ length: 33 }, () => crypto.randomUUID()) })).toBe(400);
    expect(await bad({ read: ['not-a-uuid'] })).toBe(400);
    expect(await bad({ read: [], extra: 1 })).toBe(400);
    const tooBig = { name: 'a.pdf', maxBytes: JOB_FILE_LIMITS.callBytes + 1 };
    expect(await bad({ write: tooBig })).toBe(413);
    expect(await queued('bad')).toBe(0);
  }, 60_000);

  // Verified 2.
  it("holds a key to its $storage scope and to its own view, never its issuer's", async () => {
    const asBare = (files: object) =>
      act(EXT, 'send', { tag: 'key-bare', $files: files }, { key: keys.bare });
    expect((await asBare({ read: [made.colleagueShared] })).status).toBe(403);
    expect((await asBare({ write: { name: 'a.txt', maxBytes: 9 } })).status).toBe(403);
    expect(await queued('key-bare')).toBe(0);
    // The issuer's private file, which the key did not upload.
    const own = await act(
      EXT,
      'send',
      { tag: 'key-own', $files: { read: [made.ownPrivate] } },
      { key: keys.storage },
    );
    expect(own.status).toBe(404);
    // At run time too: the issuer's shared file, made personal before the job
    // runs, is the issuer's own, which the key never was.
    gate('key-later');
    await jobId(
      await act(
        EXT,
        'send',
        { tag: 'key-later', wait: true, get: [made.ownShared], $files: { read: [made.ownShared] } },
        { key: keys.storage },
      ),
    );
    await setFile(made.ownShared!, { visibility: 'personal' });
    gates.get('key-later')!.release();
    expect(await outcome('key-later')).toBe('null');
  }, 60_000);

  // Verified 3.
  it('passes a grant only as files: true, only when the request carried one, to one job', async () => {
    const opts = await act(EXT, 'badOptions', {
      tag: 'opts',
      ids: [made.colleagueShared],
      $files: { read: [made.colleagueShared] },
    });
    expect(((await opts.json()) as { result: { threw: string } }).result.threw).toContain(
      'no form of enqueue takes file ids',
    );
    expect(await queued('opts')).toBe(0);
    expect((await act(EXT, 'send', { tag: 'none' })).status).toBe(500);
    expect(await queued('none')).toBe(0);
    const twice = await act(EXT, 'twice', {
      tag: 'twice',
      get: [made.colleagueShared],
      $files: { read: [made.colleagueShared] },
    });
    const { result } = (await twice.json()) as {
      result: { first: string; second: { threw?: string } };
    };
    expect(result.second.threw).toContain('already went to another job');
    expect(await outcome('twice')).toBe('read:4');
    expect(await queued('twice')).toBe(1);
  }, 60_000);

  // Verified 4.
  it('hands nothing to an action another action runs', async () => {
    const files = { read: [made.colleagueShared] };
    const handOn = await act(EXT, 'relayFiles', {
      tag: 'relay-files',
      ids: [made.colleagueShared],
      $files: files,
    });
    expect(handOn.status).toBe(400);
    expect(await queued('relay-files')).toBe(0);
    const inner = await act(EXT, 'relay', { tag: 'relay-inner', $files: files });
    expect(((await inner.json()) as { result: { threw: string } }).result.threw).toContain(
      'run by another action',
    );
    expect(await queued('relay-inner')).toBe(0);
    const plain = await act(EXT, 'relay', {
      tag: 'relay-plain',
      plain: true,
      get: [made.colleagueShared],
      $files: files,
    });
    expect(plain.status).toBe(200);
    expect(await outcome('relay-plain')).toBe('E403:file_not_granted');
  }, 60_000);

  // Verified 5.
  it('gives no files to a job a public route enqueued, or one enqueued without files: true', async () => {
    const hook = await app.request(`/ext/${EXT}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tag: 'hook',
        get: [made.colleagueShared],
        $files: { read: [made.colleagueShared] },
      }),
    });
    expect(hook.status).toBe(200);
    expect(await outcome('hook')).toBe('E403:file_not_granted');
    await jobId(
      await act(EXT, 'send', {
        tag: 'plain',
        plain: true,
        get: [made.colleagueShared],
        put: [1],
        $files: { read: [made.colleagueShared], write: { name: 'a.txt', maxBytes: 9 } },
      }),
    );
    expect(await outcome('plain')).toBe('E403:file_not_granted|E403:file_not_granted');
  }, 60_000);

  // Verified 6.
  it("refuses an id not in the grant, even the author's own or a shared one", async () => {
    await jobId(
      await act(EXT, 'send', {
        tag: 'ungranted',
        get: [made.ownPrivate, made.colleagueShared, made.ownShared],
        $files: { read: [made.ownShared] },
      }),
    );
    // `ownShared` was made personal above: the author's own, read as the author.
    expect(await outcome('ungranted')).toBe('E403:file_not_granted|E403:file_not_granted|read:4');
  }, 60_000);

  // Verified 7.
  it('reads null when, before the run, the file was trashed, made personal, or the key revoked', async () => {
    const trashed = await make(DEFAULT_TENANT_ID, colleague.userId, true);
    const shared = await make(DEFAULT_TENANT_ID, colleague.userId, true);
    const viaKey = await make(DEFAULT_TENANT_ID, colleague.userId, true);
    for (const [tag, id, who] of [
      ['trash', trashed, { cookie: author.cookie }],
      ['personal', shared, { cookie: author.cookie }],
      ['revoked', viaKey, { key: keys.storage }],
    ] as const) {
      gate(tag);
      await jobId(
        await act(EXT, 'send', { tag, wait: true, get: [id], $files: { read: [id] } }, who),
      );
    }
    await setFile(trashed, { deleted_at: new Date() });
    await setFile(shared, { visibility: 'personal' });
    await sql`UPDATE zv_api_keys SET is_active = false WHERE id = ${keys.storageId}::uuid`.execute(
      db,
    );
    try {
      for (const tag of ['trash', 'personal', 'revoked']) gates.get(tag)!.release();
      expect(await outcome('trash')).toBe('null');
      expect(await outcome('personal')).toBe('null');
      expect(await outcome('revoked')).toBe('null');
    } finally {
      await sql`UPDATE zv_api_keys SET is_active = true WHERE id = ${keys.storageId}::uuid`.execute(
        db,
      );
    }
  }, 60_000);

  // Verified 8 and 9.
  it("reads and stores in the engine's window, after which the job sees only its own view", async () => {
    const id = await jobId(
      await act(EXT, 'send', {
        tag: 'rw',
        get: [made.colleagueShared, made.colleaguePrivate],
        put: [101, 50, 50],
        view: true,
        $files: {
          read: [made.colleagueShared],
          write: { name: 'reply.eml', maxBytes: 100 },
        },
      }),
    );
    expect(await outcome('rw')).toBe(
      `read:4|E403:file_not_granted|E413:file_too_large|put:${id}|E409:file_already_put|view:0:on`,
    );
    const r = await row(id);
    expect(r).toMatchObject({
      id,
      tenant_id: DEFAULT_TENANT_ID,
      original_name: 'reply.eml',
      visibility: 'personal',
      folder_id: null,
      created_by: author.userId,
      created_by_api_key: null,
    });
    expect(Number(r!.size)).toBe(50);
    // Any type is stored (ADR 0033); one off the inline list is only a download.
    expect(r!.mimetype).toBe('application/octet-stream');
    expect(servedAs(r!.original_name, r!.mimetype).inline).toBe(false);
    expect((await getStorage().get(r!.storage_path))?.bytes.byteLength).toBe(50);
    // The action's audit row names what was handed.
    const audit = await until(
      () =>
        asEveryTenant(
          db,
          async (trx) =>
            (
              await sql<{ metadata: { files?: unknown } }>`
              SELECT metadata FROM zv_audit_log WHERE event_type = 'extension.action.executed'
               AND resource_id = ${`${EXT}:send`}
               AND metadata->'files'->>'write' = 'reply.eml'`.execute(trx)
            ).rows,
        ),
      (rows) => rows.length > 0,
    );
    expect(audit[0]!.metadata.files).toEqual({ read: [made.colleagueShared], write: 'reply.eml' });
  }, 60_000);

  // Verified 9.
  it("records a key's put as the key's upload, and holds it to the author's quota", async () => {
    const id = await jobId(
      await act(
        EXT,
        'send',
        { tag: 'key-put', put: [10], $files: { write: { name: 'k.txt', maxBytes: 10 } } },
        { key: keys.storage },
      ),
    );
    expect(await outcome('key-put')).toBe(`put:${id}`);
    expect(await row(id)).toMatchObject({
      created_by: author.userId,
      created_by_api_key: keys.storageId,
      visibility: 'personal',
    });
    await asTenant(db, DEFAULT_TENANT_ID, (trx) =>
      sql`INSERT INTO zv_storage_quotas (user_id, quota_bytes, used_bytes)
          VALUES (${author.userId}, 1, 0)`.execute(trx),
    );
    try {
      await jobId(
        await act(EXT, 'send', {
          tag: 'quota',
          put: [10],
          $files: { write: { name: 'q.txt', maxBytes: 10 } },
        }),
      );
      expect(await outcome('quota')).toBe('E413:file_refused');
    } finally {
      await asEveryTenant(db, (trx) =>
        sql`DELETE FROM zv_storage_quotas WHERE user_id = ${author.userId}`.execute(trx),
      );
    }
  }, 60_000);

  // Verified 11 (`files.delete` as an unknown call: unit/job-runner.test.ts).
  it('refuses every call of a job whose extension lacks files, grant or not', async () => {
    await jobId(
      await act(NOFILES, 'send', {
        tag: 'nofiles',
        get: [made.colleagueShared],
        put: [1],
        $files: { read: [made.colleagueShared], write: { name: 'a.txt', maxBytes: 9 } },
      }),
    );
    expect(await outcome('nofiles')).toBe('E403:capability_required|E403:capability_required');
  }, 60_000);

  describe('in the Deno runner', () => {
    const JOBS_JS = `
const fail = (e) => 'E' + (e.status ?? '') + ':' + e.message;
const record = (host, label) => host.collections.insert(${JSON.stringify(C)}, { label });
export default {
  // Reads a granted file and stores one, both past the 16 MiB channel.
  big: async (input, host) => {
    const back = await host.files.get(input.id);
    const bytes = new Uint8Array(input.size);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const f = await host.files.put(bytes);
    let same = back.bytes.length === input.size;
    for (let i = 0; same && i < input.size; i += 4093) same = back.bytes[i] === 77;
    await record(host, ['probe', input.tag, back.bytes.length, same, f.size].join('|'));
  },
  limits: async (input, host) => {
    const out = [];
    const tries = [
      () => host.files.put(new Uint8Array(1001)),
      () => host.files.get(input.id),
      () => host.files.put(new Uint8Array(600)),
    ];
    for (const t of tries) {
      try {
        const f = await t();
        out.push(f ? 'ok:' + f.size : 'null');
      } catch (e) {
        out.push(fail(e));
      }
    }
    await record(host, ['probe', input.tag, ...out].join('|'));
  },
  // With egress each call commits on its own: the first attempt's put stays.
  retry: async (input, host) => {
    const f = await host.files.put(new Uint8Array(input.size).fill(66));
    const mark = 'mark|' + input.tag;
    const seen = await host.collections.list(${JSON.stringify(C)}, { filter: { label: { eq: mark } } });
    if (seen.records.length === 0) {
      await record(host, mark);
      throw new Error('the first attempt fails after its put');
    }
    await record(host, ['probe', input.tag, f.id].join('|'));
  },
};
`;
    const sendDeno = (job: string, input: object, files: object, retryLimit = 0) =>
      jobQueue()!.send(
        jobQueueName(DENO, job),
        {
          tenantId: DEFAULT_TENANT_ID,
          enqueuedBy: author.userId,
          author: author.userId,
          files,
          input,
        },
        { retryLimit, retryDelay: 1, expireInSeconds: 180 },
      ) as Promise<string>;

    beforeAll(async () => {
      extDir = mkdtempSync(join(tmpdir(), 'zv-jobfiles-ext-'));
      mkdirSync(join(extDir, 'engine'));
      writeFileSync(join(extDir, 'engine', 'jobs.js'), JOBS_JS);
      const m = ManifestSchema.parse({
        name: DENO,
        engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
        integrity: { jobsSha256: createHash('sha256').update(JOBS_JS).digest('hex') },
        jobs: ['big', 'limits', 'retry'].map((job) => ({
          name: job,
          input: { type: 'object' },
          reads: [C],
          writes: [C],
          timeoutSeconds: 60,
          memoryMb: 512,
          ...(job === 'retry' ? { egress: ['files.invalid'] } : {}),
        })),
      });
      registerJobs(
        DENO,
        compileJobs(DENO, m, { name: DENO } as ZveltioExtension, true, verifiedJobsCode(extDir, m)),
        ['data:system', 'files'],
      );
      await until(
        async () =>
          Number(
            (
              await sql<{ n: string }>`SELECT count(*) AS n FROM pgboss.queue
                WHERE name LIKE ${`ext.${DENO}.%`}`.execute(db)
            ).rows[0]?.n,
          ),
        (n) => n === 3,
      );
    }, 120_000);

    it('moves a file of mail size both ways, past the 16 MiB channel', async () => {
      const size = 20 * 1024 * 1024;
      const id = await make(DEFAULT_TENANT_ID, author.userId, false, size);
      const job = await sendDeno(
        'big',
        { tag: 'big', id, size },
        { read: [id], write: { name: 'big.pdf', maxBytes: size } },
      );
      expect(await outcome('big')).toBe(`${size}|true|${size}`);
      expect(Number((await row(job))?.size)).toBe(size);
    }, 120_000);

    it('is held to the per-call and per-run byte limits', async () => {
      const id = await make(DEFAULT_TENANT_ID, author.userId, false, 1000);
      const saved = { ...JOB_FILE_LIMITS };
      JOB_FILE_LIMITS.callBytes = 1000;
      JOB_FILE_LIMITS.runBytes = 1500;
      try {
        await sendDeno(
          'limits',
          { tag: 'limits', id },
          { read: [id], write: { name: 'l.txt', maxBytes: 5000 } },
        );
        expect(await outcome('limits')).toBe(
          'E413:host.files.put: 1001 bytes; a call moves at most 1000|ok:1000|' +
            'E413:host.files.put: a run moves at most 1500 bytes',
        );
      } finally {
        Object.assign(JOB_FILE_LIMITS, saved);
      }
    }, 60_000);

    // Verified 10.
    it("answers a retried egress job's put with the file its first attempt stored", async () => {
      const driver = getStorage();
      const put = driver.put.bind(driver);
      let stores = 0;
      driver.put = async (key, bytes, opts) => {
        stores++;
        return put(key, bytes, opts);
      };
      const used = async () =>
        Number(
          (
            await sql<{ n: string }>`SELECT zveltio_media_used_bytes(${DEFAULT_TENANT_ID}::uuid,
                                     ${author.userId}::text) AS n`.execute(db)
          ).rows[0]?.n,
        );
      const before = await used();
      try {
        const job = await sendDeno(
          'retry',
          { tag: 'retry', size: 300 },
          { read: [], write: { name: 'r.txt', maxBytes: 300 } },
          1,
        );
        expect(await outcome('retry')).toBe(job);
        expect(stores).toBe(1);
        expect(await row(job)).toMatchObject({ id: job });
        expect((await used()) - before).toBe(300);
      } finally {
        driver.put = put;
      }
    }, 60_000);
  });
});
