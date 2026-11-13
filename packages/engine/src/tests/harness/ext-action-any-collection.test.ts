/**
 * ADR 0047 decision 1: an action listing `"*"` in `reads` / `writes` reaches any
 * collection, only as its caller — the data API with the caller's grants, row
 * rules and column rules; never as the system; consented as
 * `collections:any:read` / `collections:any:write`.
 *
 * Every call is made from inside an action or route of an extension loaded by
 * the engine's own loader behind the real `/ext/*` chain, and answers with what
 * `host.collections` did, so each case reads the engine's own refusal.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type {
  ActionHost,
  ExtensionContext as SdkContext,
  ZveltioExtension,
} from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { DDLManager } from '../../lib/data/index.js';
import { getAuth } from '../../lib/auth.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { toJsonb } from '../../lib/jsonb.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  forgetRuleObjects,
  getTestApp,
  harnessAvailable,
  ruleObjects,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = String(Date.now()).slice(-7);
/** No manifest names it: only `"*"` reaches it. */
const C = `anyc_${STAMP}`;
const RES = `anyc_res_${STAMP}`;
const EXT = `anyc-ext-${STAMP}`;
/** The same actions, with consent recorded for `data:*` only. */
const UNAPPROVED = `anyc-unapproved-${STAMP}`;

type Outcome = { ok?: unknown; status?: number; error?: string };
/** What `fn` did, or the refusal it threw. */
const outcome = async (fn: () => Promise<unknown>): Promise<Outcome> => {
  try {
    return { ok: await fn() };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return { status: e.status ?? 500, error: e.message };
  }
};
const labels = (body: unknown) =>
  ((body as { records: { label: string }[] }).records ?? []).map((r) => r.label).sort();

const any = { permission: { resource: RES }, input: { type: 'object' } };
const manifest = {
  permissions: ['data:write', 'data:system'],
  resources: [RES],
  actions: [
    { name: 'peek', ...any, reads: ['*'] },
    { name: 'put', ...any, writes: ['*'] },
    { name: 'peekUnlisted', ...any, reads: [] },
    { name: 'putReadOnly', ...any, reads: ['*'] },
    { name: 'peekAsSystem', ...any, reads: ['*'] },
  ],
};

function extension(name: string): ZveltioExtension {
  let ctx: SdkContext | undefined;
  const list = (host: ActionHost) => outcome(() => host.collections.list(C, { limit: 100 }));
  const insert = (host: ActionHost, label: unknown) =>
    outcome(() => host.collections.insert(C, { label }));
  return {
    name,
    category: 'custom',
    mountStrategy: 'subapp',
    actions: {
      peek: async (_input, host) => list(host),
      put: async (input, host) => insert(host, (input as { label: string }).label),
      peekUnlisted: async (_input, host) => list(host),
      putReadOnly: async (_input, host) => insert(host, 'read-only'),
      peekAsSystem: async (_input, host) =>
        outcome(() => ctx!.internals!.asSystem([C], () => host.collections.list(C))),
    },
    async register(r, c) {
      ctx = c as SdkContext;
      const h = (q: Context) => ctx!.host!(q).collections;
      const answer = (q: Context, fn: () => Promise<unknown>) => outcome(fn).then((o) => q.json(o));
      // A route of an extension whose actions list `"*"`: it is not widened.
      (r as Hono).get('/route/list', (q) => answer(q, () => h(q).list(C)));
      (r as Hono).get('/route/sys', (q) =>
        answer(q, () => ctx!.internals!.asSystem([C], () => h(q).list(C))),
      );
    },
  };
}

d('an action reaches any collection as its caller (ADR 0047)', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let god = '';
  /** Reads and creates C, runs the actions. */
  let reader = { cookie: '', userId: '' };
  /** Runs the actions, holds nothing on C. */
  let stranger = { cookie: '', userId: '' };

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
  /** `granted`: the consent recorded at install; null = none recorded (grandfathered). */
  async function load(ext: ZveltioExtension, granted: string[] | null): Promise<void> {
    const parsed = ManifestSchema.parse({ name: ext.name, version: '1.0.0', ...manifest });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${ext.name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry
        (name, display_name, tenant_id, is_installed, is_enabled, manifest, granted_capabilities)
      VALUES (${ext.name}, ${ext.name}, NULL, true, true, ${toJsonb(parsed)},
              ${granted === null ? null : toJsonb(granted)})
    `.execute(db);
    const ctx = {
      db,
      auth: getAuth(),
      events: engineEvents,
      fieldTypeRegistry: { register() {} },
      internals: buildExtensionInternals(),
    } as unknown as ExtensionContext;
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
  const run = async (ext: string, action: string, cookie: string, body: unknown = {}) => {
    const res = await app.request(`/ext/${ext}/actions/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { result: Outcome }).result;
  };
  const route = async (path: string, cookie: string) => {
    const res = await app.request(`/ext/${EXT}${path}`, { headers: { cookie } });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Outcome;
  };
  const createdBy = async (label: string) =>
    (
      await db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('zveltio.rls_bypass', 'on', true)`.execute(trx);
        return sql<{ created_by: string | null }>`
          SELECT created_by FROM ${sql.table(`zvd_${C}`)} WHERE label = ${label}`.execute(trx);
      })
    ).rows.map((r) => r.created_by);

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    await ruleObjects(db, RES);
    god = await createGodSession(engine, db, { runAsRole: false });
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    const run = { collection: RES, actions: ['execute'] };
    reader = await createMemberSession(engine, db, {
      grants: [{ collection: C, actions: ['read', 'create'] }, run],
    });
    stranger = await createMemberSession(engine, db, { grants: [run] });
    // A row rule: each person reads only the rows they created.
    const rule = await engine.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        collection: C,
        role: '*',
        filter_field: 'created_by',
        filter_op: 'eq',
        filter_value_source: 'user_id',
      }),
    });
    expect(rule.status, await rule.clone().text()).toBe(201);
    for (const [cookie, label] of [
      [reader.cookie, 'readers'],
      [god, 'gods'],
    ]) {
      const res = await engine.request(`/api/data/${C}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: cookie! },
        body: JSON.stringify({ label }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
    }

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    await load(extension(EXT), null);
    await load(extension(UNAPPROVED), ['data:system', 'data:write']);
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${UNAPPROVED})`.execute(db);
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${C}`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_audit_log WHERE resource_id LIKE ${'anyc-%'}`.execute(db);
    await dropTestCollection(db, C).catch(() => {});
    await forgetRuleObjects(db, RES);
  });

  it('reads a collection no manifest lists, as the caller: their row rules hold', async () => {
    const r = await run(EXT, 'peek', reader.cookie);
    expect(r.error).toBeUndefined();
    // The god's row is withheld by the reader's row rule.
    expect(labels(r.ok)).toEqual(['readers']);
  });

  it('a caller without the grant is refused, as the data API refuses them', async () => {
    expect(await run(EXT, 'peek', stranger.cookie)).toMatchObject({ status: 403 });
  });

  it('writes as the caller, and only a caller who may', async () => {
    expect(
      (await run(EXT, 'put', reader.cookie, { label: 'put-by-reader' })).error,
    ).toBeUndefined();
    expect(await createdBy('put-by-reader')).toEqual([reader.userId]);
    expect(await run(EXT, 'put', stranger.cookie, { label: 'put-by-stranger' })).toMatchObject({
      status: 403,
    });
    expect(await createdBy('put-by-stranger')).toEqual([]);
  });

  it('"*" in reads writes nothing, and an action without "*" reaches only what it lists', async () => {
    expect((await run(EXT, 'putReadOnly', reader.cookie)).error).toContain(
      'does not list in writes',
    );
    expect((await run(EXT, 'peekUnlisted', reader.cookie)).error).toContain(
      'does not list in reads',
    );
  });

  it('inside asSystem it is still the caller', async () => {
    expect(await run(EXT, 'peekAsSystem', stranger.cookie)).toMatchObject({ status: 403 });
    expect(labels((await run(EXT, 'peekAsSystem', reader.cookie)).ok)).toEqual([
      'put-by-reader',
      'readers',
    ]);
  });

  it('a route of that extension is not widened, asSystem or not', async () => {
    expect((await route('/route/list', reader.cookie)).error).toContain('does not list in reads');
    expect((await route('/route/sys', reader.cookie)).error).toContain('does not list in reads');
  });

  it('runs only once an administrator consented to it', async () => {
    const r = await run(UNAPPROVED, 'peek', reader.cookie);
    expect(r.error).toContain('collections:any:read');
    expect(r.ok).toBeUndefined();
  });
});
