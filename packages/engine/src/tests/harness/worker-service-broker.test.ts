// The engine brokers every service call between worker-isolated extensions,
// and three rules hold there: a worker registers only `<its name>.*`, calls only
// services owned by a declared `dependencies` entry (or itself), and a call to a
// dependency that is not running fails at once with 503 — not after the 30s
// invoke timeout.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const OWNER = `wbo${SFX}`;
const SQUATTER = `wbs${SFX}`;
const STRANGER = `wbc${SFX}`;
const DEPENDENT = `wbd${SFX}`;
const OPTIONAL = `wbp${SFX}`;
const ABSENT = `wba${SFX}`;
// Declares OWNER (1.0.0) optional at minVersion 2.0.0: too old, so absent.
const STALE_OPT = `wbv${SFX}`;

const ownerEntry = `
export default {
  name: '${OWNER}',
  async register(app, ctx) {
    ctx.services.register('${OWNER}.secret', () => 'secret');
    ctx.services.register('${OWNER}.hang', () => new Promise(() => {}));
  },
};
`;

// Loads first and claims a name the owner is going to publish.
const squatterEntry = `
export default {
  name: '${SQUATTER}',
  async register(app, ctx) {
    ctx.services.register('${OWNER}.secret', () => 'squatted');
  },
};
`;

const callerEntry = (name: string) => `
export default {
  name: '${name}',
  async register(app, ctx) {
    app.get('/call/:svc', async (c) => c.json({ out: await ctx.services.get(c.req.param('svc'))() }));
    app.get('/try/:svc', async (c) => {
      try { return c.json({ out: await ctx.services.get(c.req.param('svc'))() }); }
      catch (e) { return c.json({ error: e.message }); }
    });
  },
};
`;

function writeExt(
  base: string,
  name: string,
  entry: string,
  deps: string[] = [],
  optional: string[] = [],
  minVersion?: string,
): void {
  const dir = join(base, name);
  mkdirSync(join(dir, 'engine'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      dependencies: deps.map((n) => ({ name: n })),
      optionalDependencies: optional.map((n) => ({ name: n, minVersion })),
      engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
    }),
  );
  writeFileSync(join(dir, 'engine', 'index.js'), entry);
}

d('worker service broker: namespace, dependency allowlist, fail-fast', () => {
  let db: Database;
  let base = '';
  const app = new Hono();

  beforeAll(async () => {
    ({ db } = await getTestApp());
    base = mkdtempSync(join(tmpdir(), 'wkr-broker-'));
    writeExt(base, OWNER, ownerEntry);
    writeExt(base, SQUATTER, squatterEntry);
    writeExt(base, STRANGER, callerEntry(STRANGER));
    writeExt(base, DEPENDENT, callerEntry(DEPENDENT), [OWNER]);
    writeExt(base, OPTIONAL, callerEntry(OPTIONAL), [], [OWNER, ABSENT]);
    writeExt(base, STALE_OPT, callerEntry(STALE_OPT), [], [OWNER], '2.0.0');
    _resetWorkerHostForTests();
    getWorkerHost(app);
    const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
    for (const name of [SQUATTER, OWNER, STRANGER, DEPENDENT, OPTIONAL, STALE_OPT]) {
      await extensionLoader.loadExtension(name, app, ctx, base);
      expect(extensionLoader.getLastLoadError(name)).toBeUndefined();
    }
  }, 60_000);

  afterAll(async () => {
    await getWorkerHost(app).stopAll();
    _resetWorkerHostForTests();
    for (const name of [OWNER, SQUATTER, STRANGER, DEPENDENT, OPTIONAL, STALE_OPT]) {
      extensionLoader.loaded.delete(name);
      await revokeExtensionDbRoles(db, name, true).catch(() => undefined);
    }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  const call = async (ext: string, svc: string) => {
    const res = await app.request(`/ext/${ext}/call/${svc}`);
    return { status: res.status, body: await res.text() };
  };
  const attempt = async (ext: string, svc: string) =>
    (await (await app.request(`/ext/${ext}/try/${svc}`)).json()) as {
      out?: unknown;
      error?: string;
    };

  it("a worker cannot claim a name in another extension's namespace", async () => {
    expect(await attempt(DEPENDENT, `${OWNER}.secret`)).toEqual({ out: 'secret' });
  });

  it('a worker cannot call a service whose owner it did not declare', async () => {
    const res = await call(STRANGER, `${OWNER}.secret`);
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('secret');
    const out = await attempt(STRANGER, `${OWNER}.secret`);
    expect(out.error).toContain(`declare "${OWNER}" in its manifest dependencies`);
  });

  it('a declared dependency is callable', async () => {
    expect(await call(DEPENDENT, `${OWNER}.secret`)).toEqual({
      status: 200,
      body: JSON.stringify({ out: 'secret' }),
    });
  });

  it('an optional dependency is callable; an absent one is not found, not down', async () => {
    expect(await attempt(OPTIONAL, `${OWNER}.secret`)).toEqual({ out: 'secret' });
    expect(await attempt(OPTIONAL, `${ABSENT}.x`)).toEqual({
      error: `service "${ABSENT}.x" not found`,
    });
  });

  it('an optional dependency below its minVersion is not found, as an absent one is', async () => {
    expect(await attempt(STALE_OPT, `${OWNER}.secret`)).toEqual({
      error: `service "${OWNER}.secret" not found`,
    });
  });

  it('a call in flight when its dependency stops fails at once with 503', async () => {
    const pending = app.request(`/ext/${DEPENDENT}/call/${OWNER}.hang`);
    await Bun.sleep(300);
    await getWorkerHost(app).stop(OWNER);
    const res = await Promise.race([pending, Bun.sleep(5_000).then(() => null)]);
    expect(res?.status).toBe(503);
    expect(await res?.text()).toContain(`dependency "${OWNER}" is not running`);
  }, 15_000);

  it('a call to a dependency that is not running fails with 503', async () => {
    const res = await call(DEPENDENT, `${OWNER}.secret`);
    expect(res.status).toBe(503);
    expect(res.body).toContain(`dependency "${OWNER}" is not running`);
  });
});
