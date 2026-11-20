/**
 * ADR 0056 slice 2: a worker-isolated extension's box fails alone.
 *
 *  - an action that outlives its timeout has the statement it is running on the
 *    request's connection cancelled, and its request transaction rolled back, so
 *    a row lock it took is released at the timeout, not when Postgres's own
 *    statement timeout (or the lock it waits on) lets go;
 *  - calls into one extension beyond its concurrency limit are refused at once,
 *    holding no connection, rather than queue on the pool;
 *  - after repeated crashes the extension is disabled, with a message, and
 *    health says so.
 *
 * Driven as s1's test is: the engine's own `finalizeExtensionLoad` behind the
 * engine's own `/ext/*` chain, over the `process` transport.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { forgetActions } from '../../lib/extensions/actions.js';
import { DDLManager } from '../../lib/data/index.js';
import { getAuth } from '../../lib/auth.js';
import {
  _internalForTests,
  _resetWorkerHostForTests,
  getWorkerHost,
} from '../../lib/worker-extension-host.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { toJsonb } from '../../lib/jsonb.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import {
  asAuditOwner,
  asDefaultTenant,
  asEveryTenant,
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
const C = `wfa_${STAMP}`;
const RES = `wfa_res_${STAMP}`;
const EXT = `wfa${STAMP}`;
const CRASHY = `wfac${STAMP}`;
const TIMEOUT_MS = 2_000;

const crashy = `
export default {
  name: '${CRASHY}',
  actions: {
    crash: async () => {
      setTimeout(() => { throw new Error('the extension dies'); }, 20);
      await new Promise(() => {});
    },
    quick: async () => 'ok',
  },
  async register() {},
};
`;

const entry = `
let db;
export default {
  name: '${EXT}',
  actions: {
    // Locks the row, then runs a statement far longer than the action may.
    lockThenSleep: async (input, host) => {
      await host.collections.update('${C}', input.id, { label: 'held' });
      await db.query('SELECT pg_sleep(30)');
      return 'slept';
    },
    // Updates a row another transaction holds: an engine statement, which has
    // no statement timeout of its own, waits for as long as that one holds it.
    waitOnLock: async (input, host) => {
      await host.collections.update('${C}', input.id, { label: 'waited' });
      return 'got it';
    },
    slow: async (input) => {
      await new Promise((r) => setTimeout(r, input.ms ?? 1500));
      return 'slow';
    },
    quick: async () => 'ok',
  },
  async register(app, ctx) {
    db = ctx.db;
  },
};
`;

d('a worker-isolated extension fails alone (ADR 0056 s2)', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let base = '';
  let member: { cookie: string; userId: string };
  const saved = { transport: process.env.ZVELTIO_EXT_TRANSPORT };

  async function load(name: string, code: string, manifest: Record<string, unknown>) {
    const parsed = ManifestSchema.parse({
      name,
      version: '1.0.0',
      ...manifest,
      engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
    });
    mkdirSync(join(base, name, 'engine'), { recursive: true });
    writeFileSync(join(base, name, 'engine', 'index.js'), code);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${name}, ${name}, NULL, true, true, ${toJsonb(parsed)})
    `.execute(db);
    const ctx = {
      db,
      auth: getAuth(),
      internals: buildExtensionInternals(),
    } as unknown as ExtensionContext;
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
      { name, category: 'custom', mountStrategy: 'global', async register() {} },
      name,
      join(base, name),
      app,
      ctx,
      parsed as never,
      new Set(),
    );
  }

  const act = (name: string, body: unknown, ext = EXT) =>
    app.request(`/ext/${ext}/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: member.cookie },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    await ruleObjects(db, RES);
    _setInlineForTests(true);
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    for (let i = 0; i < 100; i++) {
      const seen = await asDefaultTenant(
        db,
        sql<{ t: string | null }>`SELECT to_regclass(${`zvd_${C}`}) AS t`,
      );
      if (seen.rows[0]?.t) break;
      await Bun.sleep(100);
    }
    member = await createMemberSession(engine, db, {
      grants: [
        { collection: C, actions: ['read', 'create', 'update'] },
        { collection: RES, actions: ['execute'] },
      ],
    });

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    _resetWorkerHostForTests();
    getWorkerHost(app);
    base = mkdtempSync(join(tmpdir(), 'wfa-'));
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    const declare = (name: string, more = {}) => ({
      name,
      permission: { resource: RES },
      input: { type: 'object' },
      ...more,
    });
    await load(EXT, entry, {
      permissions: ['data:write'],
      resources: [RES],
      actions: [
        declare('lockThenSleep', { reads: [C], writes: [C] }),
        declare('waitOnLock', { reads: [C], writes: [C] }),
        declare('slow'),
        declare('quick'),
      ],
    });
    await load(CRASHY, crashy, {
      resources: [RES],
      actions: [declare('crash'), declare('quick')],
    });
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    _internalForTests.setRequestTxnTimeoutMs();
    invalidateActivationCache();
    if (saved.transport === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved.transport;
    for (const n of [EXT, CRASHY]) {
      forgetActions(n);
      await getWorkerHost(app)
        .stop(n)
        .catch(() => undefined);
    }
    _resetWorkerHostForTests();
    if (base) rmSync(base, { recursive: true, force: true });
    if (!db) return;
    await forgetRuleObjects(db, RES);
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${CRASHY})`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v2 = ${RES}`.execute(db);
    await asAuditOwner(db, sql`DELETE FROM zv_audit_log WHERE resource_id LIKE ${`${EXT}:%`}`);
    await asAuditOwner(db, sql`DELETE FROM zv_audit_log WHERE resource_id = ${CRASHY}`);
    await asDefaultTenant(db, sql`DELETE FROM zv_revisions WHERE collection = ${C}`);
    await dropTestCollection(db, C);
  });

  it('cancels the statement a timed-out action runs and releases its row lock at the timeout', async () => {
    const [row] = (
      await asDefaultTenant(
        db,
        sql<{
          id: string;
        }>`INSERT INTO ${sql.table(`zvd_${C}`)} (label) VALUES ('free') RETURNING id`,
      )
    ).rows;
    const id = row!.id;
    _internalForTests.setRequestTxnTimeoutMs(TIMEOUT_MS);
    try {
      const started = Date.now();
      const answered = Promise.resolve(act('lockThenSleep', { id })).then(async (r: Response) => ({
        status: r.status,
        body: (await r.json()) as { code?: string },
        at: Date.now() - started,
      }));
      // Once the action holds the row: another transaction waits on its lock.
      for (let i = 0; i < 50; i++) {
        const sleeping = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(30)'
        `.execute(db);
        if (sleeping.rows[0]!.n > 0) break;
        await Bun.sleep(100);
      }
      const waited = asDefaultTenant(
        db,
        sql`UPDATE ${sql.table(`zvd_${C}`)} SET label = 'second' WHERE id = ${id}`,
      ).then(() => Date.now() - started);
      const res = await answered;
      const second = await waited;
      expect(res.status).toBe(504);
      expect(res.body.code).toBe('extension.timeout');
      // At the timeout, not at the worker's 10 s statement timeout.
      expect(res.at).toBeLessThan(TIMEOUT_MS + 3_000);
      expect(second).toBeLessThan(TIMEOUT_MS + 3_000);
      const left = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(30)'
      `.execute(db);
      expect(left.rows[0]!.n).toBe(0);
      // Nothing the action wrote was kept: the other transaction's write stands.
      const now = await asDefaultTenant(
        db,
        sql<{ label: string }>`SELECT label FROM ${sql.table(`zvd_${C}`)} WHERE id = ${id}`,
      );
      expect(now.rows[0]!.label).toBe('second');
    } finally {
      _internalForTests.setRequestTxnTimeoutMs();
    }
  }, 30_000);
  const insertRow = async (label: string) =>
    (
      await asDefaultTenant(
        db,
        sql<{
          id: string;
        }>`INSERT INTO ${sql.table(`zvd_${C}`)} (label) VALUES (${label}) RETURNING id`,
      )
    ).rows[0]!.id;
  const health = (name: string) =>
    getWorkerHost(app)
      .getHealth()
      .find((h) => h.name === name)!;

  it('cancels an engine statement the action waits in, which no statement timeout bounds', async () => {
    const id = await insertRow('locked');
    let release = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const holding = new Promise<void>((r) => {
      locked = r;
    });
    // Another transaction holds the row for longer than the test runs.
    const holder = asDefaultTenant(db, async (trx) => {
      await sql`SELECT id FROM ${sql.table(`zvd_${C}`)} WHERE id = ${id} FOR UPDATE`.execute(trx);
      locked();
      await Promise.race([released, Bun.sleep(20_000)]);
    });
    await holding;
    const errors = spyOn(console, 'error');
    _internalForTests.setRequestTxnTimeoutMs(TIMEOUT_MS);
    try {
      const started = Date.now();
      const res = await act('waitOnLock', { id });
      const at = Date.now() - started;
      expect(res.status).toBe(504);
      expect(at).toBeLessThan(TIMEOUT_MS + 3_000);
      // Named: the extension and its signing key (none until ADR 0056 s3).
      expect(
        errors.mock.calls.some((c) =>
          String(c[0]).startsWith(`[ext:${EXT} key=absent] timeout: action "waitOnLock"`),
        ),
      ).toBe(true);
    } finally {
      _internalForTests.setRequestTxnTimeoutMs();
      errors.mockRestore();
      release();
      await holder;
    }
  }, 30_000);

  it('refuses a request past the extension’s concurrency limit, and counts actions in health', async () => {
    const limit = health(EXT).concurrencyLimit;
    expect(limit).toBeGreaterThan(0);
    const before = health(EXT).totalRequests;
    const inFlight = Array.from({ length: limit }, () => act('slow', { ms: 1500 }));
    for (let i = 0; i < 50 && health(EXT).inFlightRequests < limit; i++) await Bun.sleep(50);
    expect(health(EXT).inFlightRequests).toBe(limit);
    const refused = await act('quick', {});
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(((await refused.json()) as { code: string }).code).toBe('extension.busy');
    expect((await Promise.all(inFlight)).map((r) => r.status)).toEqual(Array(limit).fill(200));
    expect(health(EXT).inFlightRequests).toBe(0);
    expect((await act('quick', {})).status).toBe(200);
    // Each action run is counted; the refused one is not.
    expect(health(EXT).totalRequests - before).toBe(limit + 1);
  }, 30_000);

  it('is disabled after repeated crashes, with a message, and health says so', async () => {
    const errors = spyOn(console, 'error');
    try {
      const answers: { status: number; code: string; detail: string }[] = [];
      for (let crash = 1; crash <= 5; crash++) {
        for (let i = 0; i < 400 && health(CRASHY).status !== 'running'; i++) await Bun.sleep(50);
        expect(health(CRASHY).status).toBe('running');
        const res = await act('crash', {}, CRASHY);
        answers.push({
          status: res.status,
          ...((await res.json()) as { code: string; detail: string }),
        });
      }
      // Its own crash mid-action, not a dependency's.
      expect(answers[0]).toMatchObject({ status: 503, code: 'extension.unavailable' });
      expect(answers[0]!.detail).toContain(`stopped while running action "crash"`);
      const h = health(CRASHY);
      expect(h.status).toBe('disabled');
      expect(h.recentCrashes).toBe(5);
      expect(h.disabledReason).toContain('disabled after 5 crashes');
      const res = await act('quick', {}, CRASHY);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'extension.disabled' });
      // A rebuild of the app keeps it disabled rather than starting it again.
      const host = getWorkerHost(app);
      host.rebindApp(new Hono());
      expect(host.remount(CRASHY)).toBe(true);
      host.rebindApp(app);
      expect(health(CRASHY).status).toBe('disabled');
      // The operator's health check names it, with why.
      const god = await createGodSession(engine, db, { factor: false });
      const deep = await engine.request('/api/health/extensions', { headers: { cookie: god } });
      expect(deep.status).toBe(503);
      const { detail } = (await deep.json()) as {
        detail: { failed: { name: string; error: string }[] };
      };
      expect(detail.failed.find((f) => f.name === CRASHY)?.error).toContain(
        'disabled after 5 crashes',
      );
      // Kept as an audit row, unlike the in-memory disable (ADR 0056, amendment §1).
      let audit: { metadata: { reason?: string; actor?: string } } | undefined;
      for (let i = 0; i < 40 && !audit; i++) {
        audit = (
          await asEveryTenant(
            db,
            sql<{ metadata: { reason?: string; actor?: string } }>`
              SELECT metadata FROM zv_audit_log
              WHERE event_type = 'extension.crash_disabled' AND resource_id = ${CRASHY}`,
          )
        ).rows[0];
        if (!audit) await Bun.sleep(50);
      }
      expect(audit?.metadata.actor).toBe('system');
      expect(audit?.metadata.reason).toContain('disabled after 5 crashes');
      expect(
        errors.mock.calls.some(
          (c) =>
            String(c[0]).startsWith(`[ext:${CRASHY} key=absent] crash:`) &&
            String(c[0]).includes('disabled after 5 crashes'),
        ),
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }
  }, 60_000);
});
