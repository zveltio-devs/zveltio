/**
 * ADR 0062 d3 (step 2a): a worker extension starts on use and stops when idle.
 *
 *  - loaded idle: verified and mounted at load, no process;
 *  - every entry point that reaches a worker starts it and waits for it: an
 *    action over HTTP, another extension's `host.actions.run`, a declared
 *    caller route, a public (webhook) route; a refused request does not;
 *  - concurrent first calls start it once;
 *  - after its idle timeout with nothing in it, the host stops it as `idle`: its
 *    process gone, no crash counted, nothing respawned, crash history kept (F17);
 *    a call in it is never cut by the timeout;
 *  - a stop the host did not order is still a crash, and respawned;
 *  - a start that fails answers `extension.unavailable` and counts as a crash;
 *  - always on (the operator's setting) is started at load and never idles.
 *
 * Driven as fail-alone's: the engine's own `finalizeExtensionLoad` behind the
 * engine's own `/ext/*` chain, over the `process` transport, the runtime setting
 * written where an operator's is (`zv_settings`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { getAuth } from '../../lib/auth.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { toJsonb } from '../../lib/jsonb.js';
import {
  createMemberSession,
  forgetRuleObjects,
  forgetRuntimeSettings,
  getTestApp,
  harnessAvailable,
  ruleObjects,
  setRuntimeSetting,
} from '../../testing/app-harness.js';
import { signAsOperator } from '../../testing/operator-signed.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = String(Date.now()).slice(-7);
const RES = `wis_res_${STAMP}`;
const EXT = `wis${STAMP}`;
const CALLER = `wisc${STAMP}`;
const ON = `wiso${STAMP}`;

const entry = `
export default {
  name: '${EXT}',
  actions: {
    quick: async () => 'ok',
    slow: async (input) => { await new Promise((r) => setTimeout(r, input.ms)); return 'slow'; },
  },
  routes: {
    mine: () => new Response('mine'),
    hook: () => new Response('hooked'),
  },
  async register() {},
};
`;
const caller = `
export default {
  name: '${CALLER}',
  actions: { relay: async (input, host) => host.actions.run('${EXT}', 'quick', {}) },
  async register() {},
};
`;
const on = `
export default { name: '${ON}', actions: { quick: async () => 'ok' }, async register() {} };
`;

d('a worker extension starts on use and stops when idle (ADR 0062 d3)', () => {
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
      resources: [RES],
      ...manifest,
      engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
    });
    mkdirSync(join(base, name, 'engine'), { recursive: true });
    writeFileSync(join(base, name, 'engine', 'index.js'), code);
    const keyId = await signAsOperator(join(base, name), name);
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
      [],
      keyId,
    );
  }

  const act = (ext: string, name: string, body: unknown = {}) =>
    app.request(`/ext/${ext}/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: member.cookie },
      body: JSON.stringify(body),
    });
  const health = (name: string) =>
    getWorkerHost(app)
      .getHealth()
      .find((h) => h.name === name)!;
  // The extension processes of this test (`process` transport): its children.
  const children = () =>
    new Set(
      Bun.spawnSync(['pgrep', '-P', String(process.pid)])
        .stdout.toString()
        .split('\n')
        .filter(Boolean)
        .map(Number),
    );
  async function until(done: () => boolean, ms = 8000) {
    for (let t = 0; t < ms && !done(); t += 50) await Bun.sleep(50);
    return done();
  }
  /** Started by `call`: the one process that appeared while it ran. */
  async function startedBy(call: () => Response | Promise<Response>) {
    expect(health(EXT).status).toBe('idle');
    const before = children();
    const gen = health(EXT).workerGeneration;
    const res = await call();
    const fresh = [...children()].filter((p) => !before.has(p));
    expect(health(EXT).status).toBe('running');
    expect(health(EXT).workerGeneration).toBe(gen + 1);
    expect(fresh.length).toBe(1);
    return { res, pid: fresh[0]! };
  }
  /** Back to idle by its timeout, as the host's own stop: no crash, process gone. */
  async function idlesOut(pid: number) {
    const crashes = health(EXT).recentCrashes;
    expect(await until(() => health(EXT).status === 'idle')).toBe(true);
    expect(health(EXT).recentCrashes).toBe(crashes);
    await until(() => !children().has(pid), 2000);
    expect(() => process.kill(pid, 0)).toThrow();
  }

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    await ruleObjects(db, RES);
    member = await createMemberSession(engine, db, {
      grants: [{ collection: RES, actions: ['execute'] }],
    });
    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    _resetWorkerHostForTests();
    getWorkerHost(app);
    base = mkdtempSync(join(tmpdir(), 'wis-'));
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    const declare = (name: string, more = {}) => ({
      name,
      permission: { resource: RES },
      input: { type: 'object' },
      ...more,
    });
    await setRuntimeSetting(db, { idleTimeoutSeconds: 1 }, EXT);
    await setRuntimeSetting(db, { alwaysOn: true }, CALLER);
    await setRuntimeSetting(db, { alwaysOn: true, idleTimeoutSeconds: 1 }, ON);
    await load(EXT, entry, {
      actions: [declare('quick'), declare('slow')],
      routes: [
        { method: 'GET', path: '/mine', access: 'caller', handler: 'mine' },
        { method: 'POST', path: '/hook', access: 'public', handler: 'hook' },
      ],
    });
    await load(CALLER, caller, {
      dependencies: [{ name: EXT }],
      actions: [declare('relay', { calls: [`${EXT}.quick`] })],
    });
    await load(ON, on, { actions: [declare('quick')] });
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (saved.transport === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved.transport;
    for (const n of [EXT, CALLER, ON]) {
      forgetActions(n);
      await getWorkerHost(app)
        .stop(n)
        .catch(() => undefined);
    }
    _resetWorkerHostForTests();
    if (base) rmSync(base, { recursive: true, force: true });
    if (!db) return;
    await forgetRuleObjects(db, RES);
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${CALLER}, ${ON})`.execute(
      db,
    );
    await sql`DELETE FROM zvd_permissions WHERE v2 = ${RES}`.execute(db);
    await forgetRuntimeSettings(db, EXT, CALLER, ON);
  });

  it('is loaded idle: verified and mounted, with no process', async () => {
    const h = health(EXT);
    expect(h).toMatchObject({ status: 'idle', alwaysOn: false, idleTimeoutMs: 1000 });
    expect(h.workerGeneration).toBe(0);
    // Its init ran once at load (a broken bundle is refused there) and ended.
    expect(
      (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM zv_settings
                                 WHERE key = ${`ext_validated:${EXT}`}`.execute(db)
      ).rows[0]!.n,
    ).toBe(1);
  });

  it('a request the engine refuses does not start it', async () => {
    const res = await app.request(`/ext/${EXT}/mine`);
    expect(res.status).toBe(401);
    expect(health(EXT).status).toBe('idle');
  });

  it('an action over HTTP starts it, and it stops after its idle timeout', async () => {
    const { res, pid } = await startedBy(() => act(EXT, 'quick'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: string }).result).toBe('ok');
    await idlesOut(pid);
    // Not respawned: the backoff (1 s) passes and it stays as it was.
    const gen = health(EXT).workerGeneration;
    await Bun.sleep(2500);
    expect(health(EXT)).toMatchObject({ status: 'idle', workerGeneration: gen, recentCrashes: 0 });
  }, 30_000);

  it('a declared caller route starts it', async () => {
    const { res, pid } = await startedBy(() =>
      app.request(`/ext/${EXT}/mine`, { headers: { cookie: member.cookie } }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('mine');
    await idlesOut(pid);
  }, 30_000);

  it('a public (webhook) route starts it, with no session', async () => {
    const { res, pid } = await startedBy(() =>
      app.request(`/ext/${EXT}/hook`, { method: 'POST', body: '{}' }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hooked');
    await idlesOut(pid);
  }, 30_000);

  it("another extension's host.actions.run starts it", async () => {
    const { res, pid } = await startedBy(() => act(CALLER, 'relay'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: string }).result).toBe('ok');
    await idlesOut(pid);
  }, 30_000);

  it('concurrent first calls start it once', async () => {
    const before = children();
    const gen = health(EXT).workerGeneration;
    // As many as it may serve at once: one more is refused as busy, started or not.
    const n = health(EXT).concurrencyLimit;
    expect(n).toBeGreaterThan(1);
    const all = await Promise.all(Array.from({ length: n }, () => act(EXT, 'quick')));
    expect(all.map((r) => r.status)).toEqual(Array(n).fill(200));
    expect(health(EXT).workerGeneration).toBe(gen + 1);
    const fresh = [...children()].filter((p) => !before.has(p));
    expect(fresh.length).toBe(1);
    await idlesOut(fresh[0]!);
  }, 30_000);

  it('a call longer than the idle timeout is never cut by it', async () => {
    const { res, pid } = await startedBy(() => act(EXT, 'slow', { ms: 2500 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: string }).result).toBe('slow');
    await idlesOut(pid);
  }, 30_000);

  it('a stop the host did not order is a crash; an idle stop then keeps the history', async () => {
    const { pid } = await startedBy(() => act(EXT, 'quick'));
    process.kill(pid, 'SIGKILL');
    expect(await until(() => health(EXT).recentCrashes === 1)).toBe(true);
    // Respawned, as every crash is.
    expect(await until(() => health(EXT).status === 'running')).toBe(true);
    // Then idle, by the host's choice: the crash it had is still counted.
    expect(await until(() => health(EXT).status === 'idle')).toBe(true);
    expect(health(EXT).recentCrashes).toBe(1);
  }, 30_000);

  it('always on: started at load and never stopped for idleness', async () => {
    expect(health(ON)).toMatchObject({ status: 'running', alwaysOn: true, idleTimeoutMs: null });
    const gen = health(ON).workerGeneration;
    expect((await act(ON, 'quick')).status).toBe(200);
    // Past its idle timeout (1 s), twice.
    await Bun.sleep(2500);
    expect(health(ON)).toMatchObject({ status: 'running', workerGeneration: gen });
  }, 30_000);

  it('a start that fails answers unavailable and counts as a crash', async () => {
    expect(health(EXT).status).toBe('idle');
    const crashes = health(EXT).recentCrashes;
    // Its files changed since load: the signature every spawn verifies refuses it.
    appendFileSync(join(base, EXT, 'engine', 'index.js'), '\n// changed\n');
    const res = await act(EXT, 'quick');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('extension.unavailable');
    expect(health(EXT)).toMatchObject({ status: 'idle', recentCrashes: crashes + 1 });
  }, 30_000);
});
