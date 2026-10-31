/**
 * A field or a collection an extension declares `writtenBy: "actions"` is
 * written only by that extension's actions and jobs, through `host.collections`.
 *
 * Every other path is refused, whoever asks: the data API (create, PATCH, PUT,
 * bulk, delete) for a member, god and an API key; sync; `ctx.internals` (the
 * path GraphQL mutations take); `ctx.db`, builder and raw; another extension's
 * action. The flag is owned structure: an operator cannot set it, the schema
 * digest covers it, and an extension's apply adds and removes it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { unregisterJobs } from '../../lib/extensions/jobs.js';
import { schemaDigest } from '../../lib/extensions/declared-collections.js';
import { DDLManager } from '../../lib/data/index.js';
import { applySchema, planExtensionSchema } from '../../lib/schema-artifact/apply.js';
import { getAuth } from '../../lib/auth.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';
import { getCurrentTenantTrx, runWithDomain, runWithTenantTrx } from '../../lib/tenancy/index.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { toJsonb } from '../../lib/jsonb.js';
import {
  asEveryTenant,
  createKeyCreator,
  createMemberSession,
  createSteppedUpGod,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
/** `status` is flagged; `label` is not. */
const F = `wba_f_${STAMP}`;
/** The whole collection is flagged. */
const W = `wba_w_${STAMP}`;
/** Nobody's, nothing flagged: what `ctx.db` may still write. */
const P = `wba_p_${STAMP}`;
/** Nobody's parent; CC's rows cascade from it, CN's flagged key is set null by it. */
const PAR = `wba_par_${STAMP}`;
const CC = `wba_cc_${STAMP}`;
const CN = `wba_cn_${STAMP}`;
/** Where the `helpdesk` template would seed `hd_categories` under this prefix. */
const PREFIX = `wba${STAMP}`;
const TPL = `${PREFIX}_hd_categories`;
const RES = `wba_res_${STAMP}`;
const RES2 = `wba_res2_${STAMP}`;
const EXT = `wba-ext-${STAMP}`;
const OTHER = `wba-other-${STAMP}`;

const text = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
  ...extra,
});
const F_FIELDS = [text('label'), text('status', { defaultValue: 'draft', writtenBy: 'actions' })];
const any = { type: 'object' };
const m2o = (name: string, onDelete: string, extra: Record<string, unknown> = {}) =>
  text(name, { type: 'm2o', options: { related_collection: PAR, on_delete: onDelete }, ...extra });

d('writtenBy: "actions" — only the owning extension’s actions and jobs write it', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let god: { app: Hono; cookie: string };
  let member: { cookie: string; userId: string };
  let keyRaw = '';
  let keyId = '';

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

  const send = (
    target: Hono,
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ) =>
    target.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const asMember = (method: string, path: string, body?: unknown) =>
    send(engine, method, path, body, { cookie: member.cookie });
  const asGod = (method: string, path: string, body?: unknown) =>
    send(god.app, method, path, body, { cookie: god.cookie });
  const asKey = (method: string, path: string, body?: unknown) =>
    send(engine, method, path, body, { 'X-API-Key': keyRaw });
  const act = (ext: string, name: string, body: unknown) =>
    send(app, 'POST', `/ext/${ext}/actions/${name}`, body, { cookie: member.cookie });
  const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;
  const row = async (table: string, id: string) =>
    (
      await sql<
        Record<string, unknown>
      >`SELECT * FROM ${sql.table(`zvd_${table}`)} WHERE id = ${id}`.execute(db)
    ).rows[0];
  const idOf = async (res: Response) => {
    const b = (await res.json()) as { id?: string; result?: { id?: string } };
    return String(b.result?.id ?? b.id);
  };
  async function until<T>(probe: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
    for (let i = 0; i < 150; i++) {
      const v = await probe();
      if (done(v)) return v;
      await Bun.sleep(100);
    }
    return probe();
  }

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    const owner = { extension: EXT, defaultGrants: true };
    const other = { extension: OTHER, defaultGrants: true };
    await DDLManager.createCollection(db, { name: F, fields: F_FIELDS } as never, owner);
    await DDLManager.createCollection(
      db,
      { name: W, writtenBy: 'actions', fields: [text('label')] } as never,
      owner,
    );
    await DDLManager.createCollection(db, { name: P, fields: [text('label')] } as never);
    await DDLManager.createCollection(db, { name: PAR, fields: [text('label')] } as never);
    await DDLManager.createCollection(
      db,
      {
        name: CC,
        writtenBy: 'actions',
        fields: [text('label'), m2o('parent', 'CASCADE')],
      } as never,
      other,
    );
    await DDLManager.createCollection(
      db,
      {
        name: CN,
        fields: [text('label'), m2o('parent', 'SET NULL', { writtenBy: 'actions' })],
      } as never,
      other,
    );
    await DDLManager.createCollection(
      db,
      { name: TPL, writtenBy: 'actions', fields: [text('name')] } as never,
      other,
    );

    const all = ['read', 'create', 'update', 'delete'];
    member = await createMemberSession(engine, db, {
      grants: [
        { collection: F, actions: all },
        { collection: W, actions: all },
        { collection: P, actions: all },
        { collection: PAR, actions: all },
        { collection: CC, actions: all },
        { collection: CN, actions: all },
        { collection: RES, actions: ['execute'] },
        { collection: RES2, actions: ['execute'] },
      ],
    });
    god = await createSteppedUpGod(engine, db);

    keyRaw = generateApiKey();
    keyId = (
      await sql<{ id: string }>`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, rate_limit, is_active, tenant_id, created_by)
        VALUES ('writtenBy probe', ${await hashApiKey(keyRaw)}, 'zvk_',
                ${JSON.stringify([{ collection: F, actions: all }])}::jsonb, 100, true,
                ${DEFAULT_TENANT_ID}::uuid, ${await createKeyCreator(db, [DEFAULT_TENANT_ID])})
        RETURNING id`.execute(db)
    ).rows[0]!.id;

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    const action = (name: string, resource = RES) => ({
      name,
      permission: { resource },
      input: any,
      reads: [F, W, CC, CN, PAR],
      writes: [F, W, CC, CN, PAR],
      enqueues: name === 'queueStatus' ? ['jobStatus'] : [],
    });
    type Input = {
      id: string;
      status: string;
      label: string;
      collection: string;
      data: Record<string, unknown>;
    };
    await load(
      {
        name: EXT,
        category: 'custom',
        mountStrategy: 'subapp',
        actions: {
          setStatus: (input, host) => {
            const { id, status } = input as Input;
            return host.collections.update(F, id, { status });
          },
          addF: (input, host) => host.collections.insert(F, input as Input),
          addW: (input, host) => host.collections.insert(W, input as Input),
          delW: (input, host) => host.collections.delete(W, (input as Input).id),
          put: (input, host) =>
            host.collections.insert((input as Input).collection, (input as Input).data),
          delAny: (input, host) =>
            host.collections.delete((input as Input).collection, (input as Input).id),
          queueStatus: async (input, host) => ({ job: await host.enqueue('jobStatus', input) }),
        },
        jobs: {
          jobStatus: async (input, host) => {
            const { id, status } = input as Input;
            await host.collections.update(F, id, { status });
          },
        },
        async register(sub, ctx) {
          // The extension's own code, outside any action: `ctx.internals`
          // (GraphQL's mutation path) and `ctx.db`, builder and raw.
          const attempt = async (run: () => Promise<unknown>) =>
            run().then(
              () => 'ok',
              (e: Error) => e.message,
            );
          sub.post('/own/:how', async (c) => {
            const { id, status } = (await c.req.json()) as Input;
            const how = c.req.param('how');
            if (how === 'internals') {
              const a = await ctx.internals!.updateRecord(c, F, id, { status });
              return c.json({ status: a.status, code: a.body.code });
            }
            const out =
              how === 'builder'
                ? await attempt(() =>
                    ctx.db
                      .updateTable(`zvd_${F}` as never)
                      .set({ label: 'by ctx.db' } as never)
                      .where('id' as never, '=', id as never)
                      .execute(),
                  )
                : how === 'raw'
                  ? await attempt(() =>
                      sql`UPDATE ${sql.table(`zvd_${W}`)} SET label = 'raw' WHERE id = ${id}`.execute(
                        ctx.db,
                      ),
                    )
                  : how === 'delpar'
                    ? await attempt(() =>
                        ctx.db
                          .deleteFrom(`zvd_${PAR}` as never)
                          .where('id' as never, '=', id as never)
                          .execute(),
                      )
                    : how === 'lock'
                      ? await attempt(() =>
                          sql`SELECT id FROM ${sql.table(`zvd_${F}`)} WHERE id = ${id} FOR UPDATE`.execute(
                            ctx.db,
                          ),
                        )
                      : await attempt(() =>
                          ctx.db
                            .insertInto(`zvd_${P}` as never)
                            .values({ label: 'plain' } as never)
                            .execute(),
                        );
            return c.json({ out });
          });
        },
      },
      {
        permissions: ['data:write', 'data:system'],
        resources: [RES],
        actions: ['setStatus', 'addF', 'addW', 'delW', 'queueStatus', 'put', 'delAny'].map((n) =>
          action(n),
        ),
        jobs: [{ name: 'jobStatus', input: any, writes: [F], retry: { limit: 0 } }],
      },
    );
    await load(
      {
        name: OTHER,
        category: 'custom',
        mountStrategy: 'subapp',
        actions: {
          poke: (input, host) => host.collections.update(F, (input as Input).id, { status: 'x' }),
          put: (input, host) =>
            host.collections.insert((input as Input).collection, (input as Input).data),
          delAny: (input, host) =>
            host.collections.delete((input as Input).collection, (input as Input).id),
        },
        async register() {},
      },
      {
        permissions: ['data:write'],
        resources: [RES2],
        actions: ['poke', 'put', 'delAny'].map((n) => action(n, RES2)),
      },
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    await unregisterJobs(EXT);
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${OTHER})`.execute(db);
    await sql`DELETE FROM zv_api_keys WHERE id = ${keyId}::uuid`.execute(db).catch(() => {});
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_revisions WHERE collection IN (${sql.join([F, W, CC, CN, PAR])})`.execute(
        trx,
      ),
    );
    for (const c of [F, W, P, CC, CN, TPL, PAR]) await dropTestCollection(db, c);
  });

  it('the data API refuses a flagged field on create, PATCH, PUT and bulk — member, god, API key', async () => {
    const created = await asMember('POST', `/api/data/${F}`, { label: 'a' });
    expect(created.status).toBe(201);
    const id = await idOf(created);
    // On create the field takes its declared default.
    expect((await row(F, id))?.status).toBe('draft');

    expect((await asMember('PATCH', `/api/data/${F}/${id}`, { label: 'b' })).status).toBe(200);
    const patched = await asMember('PATCH', `/api/data/${F}/${id}`, { status: 'sent' });
    expect(patched.status).toBe(409);
    expect(await codeOf(patched)).toBe('written_by_actions');

    for (const [who, call] of [
      ['member', asMember],
      ['god', asGod],
      ['key', asKey],
    ] as const) {
      const statuses = [
        (await call('POST', `/api/data/${F}`, { label: 'c', status: 'sent' })).status,
        (await call('PATCH', `/api/data/${F}/${id}`, { status: 'sent' })).status,
        (await call('PUT', `/api/data/${F}/${id}`, { label: 'c', status: 'sent' })).status,
        (await call('POST', `/api/data/${F}/bulk`, { records: [{ label: 'd', status: 's' }] }))
          .status,
        (await call('PATCH', `/api/data/${F}/bulk`, { records: [{ id, status: 's' }] })).status,
      ];
      expect(`${who} ${statuses.join(' ')}`).toBe(`${who} 409 409 409 409 409`);
      // The rest of the record stays theirs.
      expect((await call('PATCH', `/api/data/${F}/${id}`, { label: who })).status).toBe(200);
    }
    expect((await row(F, id))?.status).toBe('draft');
  });

  it('a flagged collection refuses every create, update and delete outside its actions', async () => {
    const added = await act(EXT, 'addW', { label: 'by action' });
    expect(added.status).toBe(200);
    const id = await idOf(added);
    expect((await row(W, id))?.label).toBe('by action');

    for (const call of [asMember, asGod]) {
      const statuses = [
        (await call('POST', `/api/data/${W}`, { label: 'x' })).status,
        (await call('PATCH', `/api/data/${W}/${id}`, { label: 'x' })).status,
        (await call('PUT', `/api/data/${W}/${id}`, { label: 'x' })).status,
        (await call('DELETE', `/api/data/${W}/${id}`)).status,
        (await call('DELETE', `/api/data/${W}/bulk`, { ids: [id] })).status,
      ];
      expect(statuses).toEqual([409, 409, 409, 409, 409]);
    }
    expect((await row(W, id))?.label).toBe('by action');

    // Sync push: a delete too, which carries no field.
    const pushed = await asMember('POST', '/api/sync/push', {
      operations: [
        { collection: W, recordId: id, operation: 'delete', clientTimestamp: Date.now() },
        {
          collection: W,
          recordId: crypto.randomUUID(),
          operation: 'create',
          payload: { label: 'synced' },
          clientTimestamp: Date.now(),
        },
      ],
    });
    const { results } = (await pushed.json()) as { results: { status: string; error?: string }[] };
    expect(results.map((r) => r.status)).toEqual(['error', 'error']);
    expect(results[0]?.error).toContain('written only by the actions');

    expect((await act(EXT, 'delW', { id })).status).toBe(200);
    expect(await row(W, id)).toBeUndefined();
  });

  it('an action and a job of the owner write it; another extension’s action is refused', async () => {
    const created = await act(EXT, 'addF', { label: 'owned', status: 'issued' });
    expect(created.status).toBe(200);
    const id = await idOf(created);
    expect((await row(F, id))?.status).toBe('issued');

    expect((await act(EXT, 'setStatus', { id, status: 'sent' })).status).toBe(200);
    expect((await row(F, id))?.status).toBe('sent');

    const poked = await act(OTHER, 'poke', { id });
    expect(poked.status).toBe(409);
    expect(await codeOf(poked)).toBe('written_by_actions');
    expect((await row(F, id))?.status).toBe('sent');

    expect((await act(EXT, 'queueStatus', { id, status: 'paid' })).status).toBe(200);
    const after = await until(
      () => row(F, id),
      (r) => r?.status === 'paid',
    );
    expect(after?.status).toBe('paid');
  });

  it('the extension’s own ctx.internals and ctx.db are refused; its reads and other tables are not', async () => {
    const id = await idOf(await asMember('POST', `/api/data/${F}`, { label: 'own' }));
    const own = async (how: string) => {
      const r = await send(
        app,
        'POST',
        `/ext/${EXT}/own/${how}`,
        { id, status: 'sent' },
        {
          cookie: member.cookie,
        },
      );
      return (await r.json()) as { out?: string; status?: number; code?: string };
    };
    expect(await own('internals')).toEqual({ status: 409, code: 'written_by_actions' });
    expect((await own('builder')).out).toContain('attempted to write');
    expect((await own('raw')).out).toContain('attempted to write');
    // Not writes: a lock, and a collection nothing flags.
    expect((await own('lock')).out).toBe('ok');
    expect((await own('plain')).out).toBe('ok');
    expect(await row(F, id)).toMatchObject({ label: 'own', status: 'draft' });
  });

  it('is owned structure: refused where no extension declares it, covered by the digest, applied by the owner', async () => {
    // An operator neither sets it on a collection nor on a field.
    const name = `wba_op_${STAMP}`;
    const create = await asGod('POST', '/api/collections', {
      name,
      writtenBy: 'actions',
      fields: [text('label')],
    });
    expect(create.status).toBe(422);
    const field = await asGod(
      'POST',
      `/api/collections/${P}/fields`,
      text('x', { writtenBy: 'actions' }),
    );
    expect(field.status).toBe(422);
    const mine = await asGod(
      'POST',
      `/api/collections/${F}/fields`,
      text('my_note', { writtenBy: 'actions' }),
    );
    expect(mine.status).toBe(422);
    await expect(
      DDLManager.createCollection(db, { name, writtenBy: 'actions', fields: [text('a')] } as never),
    ).rejects.toThrow('writtenBy');

    // The digest is over the files' bytes: the flag is in it.
    const file = (flag: boolean) =>
      new TextEncoder().encode(
        JSON.stringify({ name: F, ...(flag ? { writtenBy: 'actions' } : {}), fields: F_FIELDS }),
      );
    const digest = (flag: boolean) =>
      schemaDigest(new Map([[`collections/${F}.json`, file(flag)]]));
    expect(digest(true)).not.toBe(digest(false));

    // The owner's apply moves it: off the field, onto the collection, and back.
    const files = (collectionFlag: boolean, fields: unknown[]) => ({
      [`collections/${W}.json`]: JSON.stringify({
        name: W,
        writtenBy: 'actions',
        fields: [text('label')],
      }),
      [`collections/${F}.json`]: JSON.stringify({
        name: F,
        ...(collectionFlag ? { writtenBy: 'actions' } : {}),
        fields,
      }),
    });
    const now = files(false, F_FIELDS);
    expect(await planExtensionSchema(db, EXT, now)).toEqual([]);
    const moved = files(true, [text('label'), text('status', { defaultValue: 'draft' })]);
    const steps = await planExtensionSchema(db, EXT, moved);
    expect(steps.map((s) => `${s.change} ${s.action} ${!!s.op}`)).toEqual([
      '~ set writtenBy (unset) → "actions" true',
      '~ alter field status (writtenBy) true',
    ]);
    await applySchema(db, moved, undefined, { owner: EXT });
    expect(await planExtensionSchema(db, EXT, moved)).toEqual([]);
    const id = await idOf(await act(EXT, 'addF', { label: 'moved' }));
    // Now `label` is the extension's too.
    expect((await asMember('PATCH', `/api/data/${F}/${id}`, { label: 'x' })).status).toBe(409);
    await applySchema(db, now, undefined, { owner: EXT });
    expect(await planExtensionSchema(db, EXT, now)).toEqual([]);
    expect((await asMember('PATCH', `/api/data/${F}/${id}`, { label: 'x' })).status).toBe(200);
  }, 60_000);
  it('a delete that cascades or sets null into a flagged collection or field is refused, but not its owner’s', async () => {
    const parent = async () => idOf(await asMember('POST', `/api/data/${PAR}`, { label: 'p' }));
    const [p1, p2] = [await parent(), await parent()];
    const child = await idOf(
      await act(OTHER, 'put', { collection: CC, data: { label: 'c', parent: p1 } }),
    );
    const nulled = await idOf(
      await act(OTHER, 'put', { collection: CN, data: { label: 'n', parent: p2 } }),
    );
    expect((await row(CC, child))?.parent).toBe(p1);

    for (const p of [p1, p2]) {
      const res = await asMember('DELETE', `/api/data/${PAR}/${p}`);
      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe('written_by_actions');
    }
    expect((await asGod('DELETE', `/api/data/${PAR}/${p1}`)).status).toBe(409);
    expect((await asMember('DELETE', `/api/data/${PAR}/bulk`, { ids: [p1, p2] })).status).toBe(409);
    const pushed = await asMember('POST', '/api/sync/push', {
      operations: [{ collection: PAR, recordId: p2, operation: 'delete', clientTimestamp: 1 }],
    });
    const results = ((await pushed.json()) as { results: { error?: string }[] }).results;
    expect(results[0]?.error).toContain('would reach');
    const own = await send(
      app,
      'POST',
      `/ext/${EXT}/own/delpar`,
      { id: p1 },
      { cookie: member.cookie },
    );
    expect(((await own.json()) as { out: string }).out).toContain('would reach');
    // Another extension's action neither.
    expect((await act(EXT, 'delAny', { collection: PAR, id: p1 })).status).toBe(409);
    expect((await row(CC, child))?.parent).toBe(p1);
    expect((await row(CN, nulled))?.parent).toBe(p2);

    // The owner's action carries the cascade into its own collections.
    expect((await act(OTHER, 'delAny', { collection: PAR, id: p1 })).status).toBe(200);
    expect(await row(CC, child)).toBeUndefined();
    expect((await act(OTHER, 'delAny', { collection: PAR, id: p2 })).status).toBe(200);
    expect((await row(CN, nulled))?.parent).toBeNull();
  });

  it('ctx.DDLManager changes no collection an extension declares, flagged or not', async () => {
    const { announcingDDLManager: ddl } = await import('../../lib/extensions/register.js');
    const refused = { code: 'written_by_actions', status: 409 };
    await expect(ddl.removeField(db, F, 'status')).rejects.toMatchObject(refused);
    await expect(ddl.dropCollection(db, W)).rejects.toMatchObject(refused);
    await expect(
      ddl.updateCollectionMetadata(db, F, { fields: [text('label')] as never }),
    ).rejects.toMatchObject(refused);
    await expect(
      ddl.setFieldKeys(db, CN, { name: 'label', type: 'text' } as never, []),
    ).rejects.toMatchObject(refused);
    await expect(ddl.addField(db, P, text('x', { writtenBy: 'actions' }))).rejects.toMatchObject(
      refused,
    );
    expect(await DDLManager.tableExists(db, W)).toBe(true);
    // A collection nobody declares is still the extension's to change.
    await ddl.addField(db, P, text('extra'));
    expect(await DDLManager.columnNames(db, P)).toContain('extra');
  });

  it('a revision revert and template seeding are refused too', async () => {
    const id = await idOf(await act(EXT, 'addF', { label: 'rev', status: 'issued' }));
    expect((await act(EXT, 'setStatus', { id, status: 'sent' })).status).toBe(200);
    const created = await asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<{ id: string }>`SELECT id FROM zv_revisions
            WHERE collection = ${F} AND record_id = ${id} AND action = 'create'`.execute(trx)
        ).rows[0]?.id,
    );
    expect(created).toBeString();
    const revert = await asGod('POST', `/api/revisions/${created}/revert`, {});
    expect(revert.status).toBe(409);
    expect((await row(F, id))?.status).toBe('sent');

    const seed = await asGod('POST', '/api/templates/helpdesk/seed', { prefix: PREFIX });
    expect(seed.status).toBe(409);
    expect(await codeOf(seed)).toBe('written_by_actions');
  });

  it('reads the flags on the engine pool, never under the request transaction’s role', async () => {
    // A request role that may write the collections and may not read the
    // catalog the check needs: the flags must come from elsewhere.
    const role = `wba_role_${STAMP}`;
    await sql.raw(`CREATE ROLE "${role}" NOSUPERUSER`).execute(db);
    await sql
      .raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "zvd_${P}", "zvd_${W}" TO "${role}"`)
      .execute(db);
    const ctxDb = createRestrictedDb(() => getCurrentTenantTrx() ?? db, 'wba-role', new Set());
    const asRequest = <T>(fn: () => Promise<T>) =>
      runWithDomain(DEFAULT_TENANT_ID, () =>
        db.transaction().execute(async (trx) => {
          await sql.raw(`SET LOCAL ROLE "${role}"`).execute(trx);
          await sql`
            SELECT set_config('zveltio.current_tenant', ${DEFAULT_TENANT_ID}, true),
                   set_config('zveltio.actor', 'on', true),
                   set_config('zveltio.collection_grants', ${`,${P}:*,${W}:*,`}, true)
          `.execute(trx);
          return runWithTenantTrx(trx as unknown as Database, DEFAULT_TENANT_ID, fn);
        }),
      );
    try {
      // Not from the cache: the definitions are read now.
      DDLManager.invalidateCache();
      await asRequest(() =>
        sql`INSERT INTO ${sql.table(`zvd_${P}`)} (label) VALUES ('under role')`.execute(ctxDb),
      );
      DDLManager.invalidateCache();
      await expect(
        asRequest(() =>
          sql`INSERT INTO ${sql.table(`zvd_${W}`)} (label) VALUES ('under role')`.execute(ctxDb),
        ),
      ).rejects.toThrow('attempted to write');
      DDLManager.invalidateCache();
      await asRequest(() =>
        sql`DELETE FROM ${sql.table(`zvd_${P}`)} WHERE label = 'under role'`.execute(ctxDb),
      );
    } finally {
      await sql.raw(`DROP OWNED BY "${role}"`).execute(db);
      await sql.raw(`DROP ROLE "${role}"`).execute(db);
    }
  });
});
