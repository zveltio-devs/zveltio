// An inline extension gets `ctx.services` under the rules the broker holds a
// worker to: it registers only `<its name>.*` and reads only services owned by
// itself or by an extension its manifest names in `dependencies` /
// `optionalDependencies`. An optional dependency that is not installed is not a
// load error; its services read as null. Loaded the way the loader loads one.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { topoSortExtensions } from '../../lib/extensions/discovery.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const OWNER = `ibo${SFX}`;
const STRANGER = `ibs${SFX}`;
const DEPENDENT = `ibd${SFX}`;
const OPTIONAL = `ibp${SFX}`;
const ABSENT = `iba${SFX}`;
const SQUATTER = `ibq${SFX}`;
const ALL = [OWNER, STRANGER, DEPENDENT, OPTIONAL, SQUATTER];

const ownerEntry = `
export default {
  name: '${OWNER}',
  async register(app, ctx) {
    ctx.services.register('${OWNER}.secret', () => 'secret');
  },
};
`;

const squatterEntry = `
export default {
  name: '${SQUATTER}',
  async register(app, ctx) {
    ctx.services.register('${OWNER}.other', () => 'squatted');
  },
};
`;

const callerEntry = (name: string) => `
export default {
  name: '${name}',
  mountStrategy: 'subapp',
  async register(app, ctx) {
    app.get('/try/:svc', (c) => {
      try {
        const fn = ctx.services.get(c.req.param('svc'));
        return c.json({ out: fn === null ? null : fn() });
      } catch (e) { return c.json({ error: e.message }); }
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
): void {
  const dir = join(base, name);
  mkdirSync(join(dir, 'engine'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      dependencies: deps.map((n) => ({ name: n })),
      optionalDependencies: optional.map((n) => ({ name: n })),
      engine: { entry: 'engine/index.js', bundled: true },
    }),
  );
  writeFileSync(join(dir, 'engine', 'index.js'), entry);
}

d('inline service broker: namespace, declared owners, optional dependencies', () => {
  let db: Database;
  let base = '';
  const app = new Hono();
  const inlineBefore = process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    // Enabled, so `/ext/<name>/*` answers rather than 404 "not active".
    for (const name of ALL) {
      await sql`
        INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
        VALUES (${name}, ${name}, NULL, true, true)`.execute(db);
      invalidateActivationCache(name);
    }
    base = mkdtempSync(join(tmpdir(), 'inl-broker-'));
    writeExt(base, OWNER, ownerEntry);
    writeExt(base, STRANGER, callerEntry(STRANGER));
    writeExt(base, DEPENDENT, callerEntry(DEPENDENT), [OWNER]);
    writeExt(base, OPTIONAL, callerEntry(OPTIONAL), [], [OWNER, ABSENT]);
    writeExt(base, SQUATTER, squatterEntry);
    const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
    // Dependents first in the input: the sort must put OWNER ahead of both.
    const order = await topoSortExtensions([OPTIONAL, DEPENDENT, STRANGER, OWNER, SQUATTER], base);
    expect(order.indexOf(OWNER)).toBeLessThan(order.indexOf(OPTIONAL));
    expect(order.indexOf(OWNER)).toBeLessThan(order.indexOf(DEPENDENT));
    for (const name of order) await extensionLoader.loadExtension(name, app, ctx, base);
  }, 60_000);

  afterAll(async () => {
    if (inlineBefore === undefined) delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
    else process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = inlineBefore;
    for (const name of ALL) {
      serviceRegistry.unregisterAll(name);
      extensionLoader.loaded.delete(name);
      await revokeExtensionDbRoles(db, name, true).catch(() => undefined);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
    }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  const attempt = async (ext: string, svc: string) =>
    (await (await app.request(`/ext/${ext}/try/${svc}`)).json()) as {
      out?: unknown;
      error?: string;
    };

  it("an inline extension cannot register a name in another's namespace", () => {
    expect(extensionLoader.getLastLoadError(SQUATTER)).toContain(
      `may register only services named "${SQUATTER}.<name>"`,
    );
    expect(serviceRegistry.has(`${OWNER}.other`)).toBe(false);
  });

  it('an inline extension cannot call a service whose owner it did not declare', async () => {
    expect(extensionLoader.getLastLoadError(STRANGER)).toBeUndefined();
    const out = await attempt(STRANGER, `${OWNER}.secret`);
    expect(out.out).toBeUndefined();
    expect(out.error).toContain(`declare "${OWNER}" in its manifest dependencies`);
  });

  it('a declared dependency is callable', async () => {
    expect(await attempt(DEPENDENT, `${OWNER}.secret`)).toEqual({ out: 'secret' });
  });

  it('an installed optional dependency is callable', async () => {
    expect(extensionLoader.getLastLoadError(OPTIONAL)).toBeUndefined();
    expect(await attempt(OPTIONAL, `${OWNER}.secret`)).toEqual({ out: 'secret' });
  });

  it('an absent optional dependency is no load error, and its service reads as null', async () => {
    expect(extensionLoader.loaded.has(OPTIONAL)).toBe(true);
    expect(await attempt(OPTIONAL, `${ABSENT}.anything`)).toEqual({ out: null });
  });
});
