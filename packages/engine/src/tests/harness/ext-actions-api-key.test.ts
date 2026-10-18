/**
 * An API key running an extension action: `POST /ext/<name>/actions/<action>`
 * with `X-API-Key`.
 *
 * The key model of every other `/ext/*` surface: the key's scopes are its whole
 * grant and Casbin is never asked. `$ext:<name>` with the action's declared
 * permission action (`execute` by default) opens the action — no manifest
 * `apiKeyRoutes` entry, and no `create` on the extension's other POST routes.
 * The action's writes go through the data API as the key, so each collection
 * it touches must be in the key's scopes too. A key's creator gates it only by
 * still being allowed to sign in (and, in an ordinary tenant, by membership).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad, reRegisterExtension } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `akact_${STAMP}`;
const RES = `akact_res_${STAMP}`;
const EXT = `akact-ext-${STAMP}`;

d('an API key runs an extension action with $ext:<name> execute', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let godCookie: string;
  let godId: string;
  let loader: ExtensionLoader;
  const keys: string[] = [];

  const mint = async (scopes: unknown) => {
    const res = await engine.request('/api/admin/api-keys', {
      method: 'POST',
      headers: { cookie: godCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `akact-${keys.length}`, scopes }),
    });
    const body = (await res.json()) as { id: string; key: string };
    keys.push(body.id);
    return body.key;
  };
  const act = (name: string, body: unknown, key: string) =>
    app.request(`/ext/${EXT}/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(body),
    });
  const rowsLabelled = async (label: string) =>
    (
      await sql<{ created_by: string | null }>`
        SELECT created_by FROM ${sql.table(`zvd_${C}`)} WHERE label = ${label}
      `.execute(db)
    ).rows;
  const execute = { collection: `$ext:${EXT}`, actions: ['execute'] };
  const writeC = { collection: C, actions: ['read', 'create'] };

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    godCookie = await createGodSession(engine, db);
    godId = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]!.id;
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

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    const ext: ZveltioExtension = {
      name: EXT,
      category: 'custom',
      mountStrategy: 'subapp',
      actions: {
        addItem: async (input, host) => {
          const rec = await host.collections.insert(C, input as Record<string, unknown>);
          return host.collections.read(C, String(rec.id));
        },
        approve: async () => 'approved',
      },
      async register(sub) {
        sub.post('/other', (c) => c.json({ other: true }));
      },
    };
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${EXT}, ${EXT}, NULL, true, true)
    `.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    loader = {
      loaded: new Map(),
      modules: new Map([[EXT, ext]]),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
    await finalizeExtensionLoad(
      loader,
      ext,
      EXT,
      `/tmp/${EXT}`,
      app,
      ctx,
      ManifestSchema.parse({
        name: EXT,
        permissions: ['data:write'],
        // Must not turn an action's gate into `create` (see the `approve` case).
        apiKeyRoutes: ['POST /actions/*'],
        resources: [RES],
        actions: [
          {
            name: 'addItem',
            permission: { resource: RES },
            input: {
              type: 'object',
              properties: { label: { type: 'string' } },
              required: ['label'],
            },
            reads: [C],
            writes: [C],
          },
          // An action asked by name: the key must name it, `execute` does not reach it.
          { name: 'approve', permission: { resource: RES, action: 'approve' }, input: {} },
        ],
      }) as never,
      new Set(),
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    for (const id of keys) await sql`DELETE FROM zv_api_keys WHERE id = ${id}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v2 = ${RES}`.execute(db);
    await sql`DELETE FROM zv_revisions WHERE collection = ${C}`.execute(db);
    await dropTestCollection(db, C);
  });

  it('runs with execute on the extension and the collection write, as its issuer', async () => {
    const res = await act('addItem', { label: 'by-key' }, await mint([execute, writeC]));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { label: string } }).result.label).toBe('by-key');
    expect(await rowsLabelled('by-key')).toEqual([{ created_by: godId }]);
  });

  it('keeps the actions open to a key across a re-register (enable, hot-reload)', async () => {
    await reRegisterExtension(loader, EXT, app);
    const res = await act('addItem', { label: 'reregistered' }, await mint([execute, writeC]));
    expect(res.status).toBe(200);
  });

  it('execute opens the action, not the collections it writes', async () => {
    const res = await act('addItem', { label: 'exec-only' }, await mint([execute]));
    // Past the action's gate, refused by the data API as the key.
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('action_data_refused');
    expect(await rowsLabelled('exec-only')).toEqual([]);
  });

  it('refuses a key without execute on this extension, before running anything', async () => {
    for (const scopes of [
      // Every other POST route of the extension is not the action.
      [{ collection: `$ext:${EXT}`, actions: ['create'] }, writeC],
      // A `*` collection does not reach an extension.
      [{ collection: '*', actions: ['*'] }],
      [{ collection: `$ext:${EXT}-other`, actions: ['execute'] }, writeC],
    ]) {
      const res = await act('addItem', { label: 'no-exec' }, await mint(scopes));
      expect(res.status).toBe(403);
    }
    expect(await rowsLabelled('no-exec')).toEqual([]);
  });

  it('asks the action’s own permission action, not execute', async () => {
    expect((await act('approve', {}, await mint([execute]))).status).toBe(403);
    const named = await mint([{ collection: `$ext:${EXT}`, actions: ['approve'] }]);
    const res = await act('approve', {}, named);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'approved' });
  });

  it('opens the actions to a key, not the extension’s other routes', async () => {
    const key = await mint([{ collection: `$ext:${EXT}`, actions: ['*'] }]);
    const other = await app.request(`/ext/${EXT}/other`, {
      method: 'POST',
      headers: { 'x-api-key': key },
    });
    expect(other.status).toBe(403);
    expect(((await other.json()) as { code: string }).code).toBe('EXT_SESSION_REQUIRED');
  });

  // Scopes are the key's whole grant: its creator's roles are not consulted —
  // keys are minted by an instance administrator only (`/api/admin/api-keys`).
  // What the creator's standing does decide is whether the key works at all.
  it('a key acts on its scopes, and stops when its creator may no longer sign in', async () => {
    const creator = await createMemberSession(engine, db); // holds nothing on RES or C
    const raw = generateApiKey();
    const row = await sql<{ id: string }>`
      INSERT INTO zv_api_keys
        (name, key_hash, key_prefix, scopes, created_by, is_active, tenant_id)
      VALUES ('akact-member', ${await hashApiKey(raw)}, ${raw.slice(0, 12)},
              ${JSON.stringify([execute, writeC])}::jsonb, ${creator.userId}, true,
              ${DEFAULT_TENANT_ID})
      RETURNING id
    `.execute(db);
    keys.push(row.rows[0]!.id);
    expect((await act('addItem', { label: 'member-key' }, raw)).status).toBe(200);
    expect(await rowsLabelled('member-key')).toEqual([{ created_by: creator.userId }]);

    await sql`UPDATE "user" SET banned = true WHERE id = ${creator.userId}`.execute(db);
    expect((await act('addItem', { label: 'banned-key' }, raw)).status).toBe(401);
    expect(await rowsLabelled('banned-key')).toEqual([]);
  });
});
