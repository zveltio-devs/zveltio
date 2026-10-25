/**
 * Extension model v3: an extension action gated on a collection the extension
 * declares (its actions' or jobs' `reads`/`writes`), not on a manifest
 * `resources` entry.
 *
 * Before, the manifest refused it ("not in resources"), so an extension could
 * not drop the free-string `resources` before v2. Now the engine grants the
 * default `execute` on that collection as it does on a declared resource — on
 * load, on the boot reconcile, and when the collection is created after the
 * extension is installed — and only once the collection exists. The rule is the
 * collection's: the role editor offers it there, and dropping the collection
 * takes it (extension model v3: its rules live and die with it), because the name is not a non-collection object.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { DDLManager } from '../../lib/data/index.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { getEnforcer, invalidateAllPermissionCaches } from '../../lib/tenancy/permissions.js';
import {
  listDeclaredResources,
  nonCollectionObjects,
  recordManifest,
} from '../../lib/tenancy/resource-grants.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const G = `actcol_${STAMP}`;
/** Declared in `writes` and gated on, but never created: nothing is granted on it. */
const GHOST = `actcol_ghost_${STAMP}`;
const EXT = `actcol-ext-${STAMP}`;

const manifest = {
  name: EXT,
  actions: [
    { name: 'go', permission: { resource: G }, input: { type: 'object' }, writes: [G] },
    { name: 'haunt', permission: { resource: GHOST }, input: { type: 'object' }, writes: [GHOST] },
  ],
};

d('an extension action gated on a collection it declares', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let god: string;
  let tenantMember: { cookie: string; userId: string };
  let extRoot: string;
  let savedDir: string | undefined;

  const executeHolders = async (resource: string) =>
    (
      await sql<{ v0: string }>`
        SELECT v0 FROM zvd_permissions
        WHERE ptype = 'p' AND v1 = '*' AND v2 = ${resource} AND v3 = 'execute'
      `.execute(db)
    ).rows.map((r) => r.v0);
  const create = (name: string) =>
    DDLManager.createCollection(db, {
      name,
      fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  const install = async () => {
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${EXT}, ${EXT}, NULL, true, true)
    `.execute(db);
    // As the install route does: the claim is read from the row.
    await recordManifest(db, EXT, join(extRoot, EXT));
  };

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    god = await createGodSession(engine, db);
    tenantMember = await createMemberSession(engine, db);
    const e = await getEnforcer();
    await e.addRoleForUser(tenantMember.userId, 'tenant_member', DEFAULT_TENANT_ID);
    await invalidateAllPermissionCaches();

    extRoot = mkdtempSync(join(tmpdir(), 'ext-actcol-'));
    mkdirSync(join(extRoot, EXT), { recursive: true });
    writeFileSync(join(extRoot, EXT, 'manifest.json'), JSON.stringify(manifest));
    savedDir = process.env.EXTENSIONS_DIR;
    process.env.EXTENSIONS_DIR = extRoot;

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (savedDir === undefined) delete process.env.EXTENSIONS_DIR;
    else process.env.EXTENSIONS_DIR = savedDir;
    if (extRoot) rmSync(extRoot, { recursive: true, force: true });
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v2 IN (${G}, ${GHOST})`.execute(db);
    await sql`DELETE FROM zv_audit_log WHERE resource_id LIKE ${`${EXT}:%`}`.execute(db);
    await dropTestCollection(db, G).catch(() => {});
  });

  it('the manifest is accepted, and loading grants execute on the existing collection only', async () => {
    await create(G);
    // Not installed yet: a collection alone gets no `execute`.
    expect(await executeHolders(G)).toEqual([]);

    await install();
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    const loader = {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
    const ext: ZveltioExtension = {
      name: EXT,
      category: 'custom',
      mountStrategy: 'subapp',
      actions: { go: async () => 'ran', haunt: async () => 'ran' },
      async register() {},
    };
    await finalizeExtensionLoad(
      loader,
      ext,
      EXT,
      join(extRoot, EXT),
      app,
      ctx,
      ManifestSchema.parse(manifest) as never,
      new Set(),
    );
    invalidateActivationCache();

    expect(await executeHolders(G)).toEqual(['tenant_member']);
    // A rule on an object that does not exist is not written (extension model v3).
    expect(await executeHolders(GHOST)).toEqual([]);

    const res = await app.request(`/ext/${EXT}/actions/go`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: tenantMember.cookie },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'ran' });
  });

  it('is the collection’s rule: reconciled, offered in the role editor, not reserved', async () => {
    const declared = await listDeclaredResources(db);
    expect(declared).toContain(G);
    expect(declared).not.toContain(GHOST);
    expect((await nonCollectionObjects(db)).has(G)).toBe(false);

    const res = await engine.request('/api/admin/resources', { headers: { cookie: god } });
    const { resources } = (await res.json()) as {
      resources: Array<{ name: string; type: string; actions: string[] }>;
    };
    expect(resources.find((r) => r.name === G)).toMatchObject({
      type: 'collection',
      actions: ['read', 'create', 'update', 'delete', 'execute'],
    });
    expect(resources.some((r) => r.name === GHOST)).toBe(false);
  });

  it('goes with the collection, and a collection created after install gets it', async () => {
    await DDLManager.dropCollection(db, G, {});
    expect(await executeHolders(G)).toEqual([]);

    await create(G);
    expect(await executeHolders(G)).toEqual(['tenant_member']);
  });
});
