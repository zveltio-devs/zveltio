/**
 * ADR 0056 slice 1: an action of a worker-isolated extension is served — run in
 * its worker, over the runner protocol (`process` transport), with the engine
 * deciding everything around it exactly as for an inline one: the caller's
 * permission, the input schema, the declared collections, the request
 * transaction the action's writes land in, and its refusal's status and code.
 *
 * Loaded by the engine's own `finalizeExtensionLoad` behind the engine's own
 * `/ext/*` chain (prefetch, tenant transaction, auth gate).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
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
import { jobQueueName, unregisterJobs } from '../../lib/extensions/jobs.js';
import { getStorage } from '../../lib/storage/index.js';
import { type FileActor, storeFile } from '../../lib/stored-files.js';
import { DDLManager } from '../../lib/data/index.js';
import { getAuth } from '../../lib/auth.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { getEnforcer, invalidateAllPermissionCaches } from '../../lib/tenancy/permissions.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';
import { effectiveTimeZone } from '../../lib/tenancy/timezone.js';
import { toJsonb } from '../../lib/jsonb.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import {
  asAuditOwner,
  asDefaultTenant,
  asEveryTenant,
  asTenant,
  createMemberSession,
  dropTestCollection,
  forgetRuleObjects,
  getTestApp,
  harnessAvailable,
  ruleObjects,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
// Module state every later file of one `bun test` run shares: put back what was there.
let wasInline = false;
const STAMP = String(Date.now()).slice(-7);
const C = `wact_${STAMP}`;
const OTHER = `wact_other_${STAMP}`;
const RES = `wact_res_${STAMP}`;
const EXT = `wact${STAMP}`;
const BAD = `wactb${STAMP}`;
const DEP = `wactd${STAMP}`;

const labelInput = {
  type: 'object',
  properties: { label: { type: 'string', minLength: 1 } },
  required: ['label'],
  additionalProperties: false,
};

// What the SDK's `ActionRefusal` is, as a bundle carries its own copy of it.
const entry = `
const ACTION_REFUSAL = Symbol.for('zveltio.extension.action-refusal');
class ActionRefusal extends Error {
  [ACTION_REFUSAL] = true;
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export default {
  name: '${EXT}',
  actions: {
    addItem: async (input, host) => {
      const rec = await host.collections.insert('${C}', input);
      return host.collections.read('${C}', String(rec.id));
    },
    addThenRefuse: async (input, host) => {
      await host.collections.insert('${C}', input);
      throw new ActionRefusal(409, 'item_conflicts', 'This item conflicts with another.');
    },
    addThenThrow: async (input, host) => {
      await host.collections.insert('${C}', input);
      throw new Error('the action failed after writing');
    },
    refuseOddly: async (input) => {
      throw new ActionRefusal(input.status, 'odd', 'odd');
    },
    // Writes what it may, then reaches a collection its manifest does not list.
    sneak: async (input, host) => {
      await host.collections.insert('${C}', { label: input.label });
      return input.mode === 'read'
        ? host.collections.list('${OTHER}')
        : host.collections.insert('${OTHER}', { label: 'sneaked' });
    },
    // Catches the data API's refusal and lets it through: the engine's own answers.
    caughtThenRethrown: async (input, host) => {
      try {
        return await host.collections.insert('${C}', input);
      } catch (err) {
        throw err;
      }
    },
    zone: async (_input, host) => host.timezone,
    // The members of ActionHost beyond collections, each a call over the channel.
    readFile: async (input, host) => {
      const f = await host.files.read(input.id);
      return { name: f.name, bytes: Array.from(f.bytes), isBytes: f.bytes instanceof Uint8Array };
    },
    putFile: async (_input, host) => host.files.put(new Uint8Array([7, 8, 9])),
    queue: async (input, host) => host.enqueue('noop', { n: input.n }),
    relay: async (input, host) => host.actions.run('${DEP}', 'echo', input),
  },
  async register() {},
};
`;

// A worker extension's jobs run in the Deno runner, from their own file.
const JOBS_JS = 'export default { noop: async () => {} };\n';

const depEntry = `
export default {
  name: '${DEP}',
  actions: { echo: async (input) => ({ echoed: input.label }) },
  async register() {},
};
`;

d('a worker-isolated extension’s actions run in its worker, decided by the engine', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let base = '';
  let member: { cookie: string; userId: string };
  let outsider: { cookie: string; userId: string };
  let tenantMember: { cookie: string; userId: string };
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
    // The stub `load.ts` hands the loader for a worker: the module is never imported here.
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

  const act = (name: string, body: unknown, cookie: string) =>
    app.request(`/ext/${EXT}/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  const rowsLabelled = async (label: string, collection = C) =>
    (
      await asDefaultTenant(
        db,
        sql<{ id: string; created_by: string | null }>`
        SELECT id, created_by FROM ${sql.table(`zvd_${collection}`)} WHERE label = ${label}
      `,
      )
    ).rows;

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    await ruleObjects(db, RES);
    wasInline = _setInlineForTests(true);
    for (const name of [C, OTHER]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
      } as never);
      for (let i = 0; i < 100; i++) {
        const seen = await asDefaultTenant(
          db,
          sql<{ t: string | null }>`SELECT to_regclass(${`zvd_${name}`}) AS t`,
        );
        if (seen.rows[0]?.t) break;
        await Bun.sleep(100);
      }
    }
    const data = (collection: string) => ({
      collection,
      actions: ['read', 'create', 'update'],
    });
    // The caller may write OTHER: only the manifest keeps the action out of it.
    member = await createMemberSession(engine, db, {
      grants: [data(C), data(OTHER), { collection: RES, actions: ['execute'] }],
    });
    outsider = await createMemberSession(engine, db, { grants: [data(C)] });
    tenantMember = await createMemberSession(engine, db);
    const e = await getEnforcer();
    await e.addRoleForUser(tenantMember.userId, 'tenant_member', DEFAULT_TENANT_ID);
    await invalidateAllPermissionCaches();

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    _resetWorkerHostForTests();
    getWorkerHost(app);
    base = mkdtempSync(join(tmpdir(), 'wact-'));
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';

    const declare = (name: string, input: unknown = { type: 'object' }, more = {}) => ({
      name,
      permission: { resource: RES },
      input,
      ...more,
    });
    await load(DEP, depEntry, { resources: [RES], actions: [declare('echo')] });
    mkdirSync(join(base, EXT, 'engine'), { recursive: true });
    writeFileSync(join(base, EXT, 'engine', 'jobs.js'), JOBS_JS);
    await load(EXT, entry, {
      integrity: { jobsSha256: createHash('sha256').update(JOBS_JS).digest('hex') },
      // `data:system`: a job acts beyond its caller (ADR 0047).
      permissions: ['data:write', 'data:system', 'files'],
      resources: [RES],
      dependencies: [{ name: DEP }],
      jobs: [{ name: 'noop', input: { type: 'object' }, retry: { limit: 0 } }],
      actions: [
        declare('addItem', labelInput, { reads: [C], writes: [C] }),
        declare('addThenRefuse', labelInput, { writes: [C] }),
        declare('addThenThrow', labelInput, { writes: [C] }),
        declare('refuseOddly', { type: 'object', properties: { status: { type: 'integer' } } }),
        declare('sneak', undefined, { writes: [C] }),
        declare('caughtThenRethrown', labelInput, { writes: [C] }),
        declare('zone'),
        declare('readFile'),
        declare('putFile'),
        declare('queue', undefined, { enqueues: ['noop'] }),
        declare('relay', undefined, { calls: [`${DEP}.echo`] }),
      ],
    });
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    _setInlineForTests(wasInline);
    invalidateActivationCache();
    if (saved.transport === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved.transport;
    for (const n of [EXT, BAD, DEP]) {
      forgetActions(n);
      await getWorkerHost(app)
        .stop(n)
        .catch(() => undefined);
    }
    await unregisterJobs(EXT);
    _resetWorkerHostForTests();
    if (base) rmSync(base, { recursive: true, force: true });
    if (!db) return;
    await forgetRuleObjects(db, RES);
    const files = await asEveryTenant(db, (trx) =>
      trx
        .selectFrom('zv_media_files')
        .select(['id', 'storage_path'])
        .where('created_by', '=', member.userId)
        .execute(),
    );
    for (const f of files) {
      await getStorage()
        .delete(f.storage_path)
        .catch(() => undefined);
    }
    await asEveryTenant(db, (trx) =>
      trx.deleteFrom('zv_media_files').where('created_by', '=', member.userId).execute(),
    );
    await sql`DELETE FROM pgboss.job WHERE name = ${jobQueueName(EXT, 'noop')}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name LIKE ${`${EXT.slice(0, 4)}%${STAMP}`}`.execute(
      db,
    );
    await sql`DELETE FROM zvd_permissions WHERE v2 = ${RES}`.execute(db);
    await asAuditOwner(db, sql`DELETE FROM zv_audit_log WHERE resource_id LIKE ${`${EXT}:%`}`);
    await asDefaultTenant(db, sql`DELETE FROM zv_revisions WHERE collection IN (${C}, ${OTHER})`);
    await dropTestCollection(db, C);
    await dropTestCollection(db, OTHER);
  });

  it('runs as the caller, in the request transaction, and answers its result', async () => {
    const res = await act('addItem', { label: 'by-member' }, member.cookie);
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { id: string; label: string } };
    expect(result.label).toBe('by-member');
    expect(await rowsLabelled('by-member')).toEqual([{ id: result.id, created_by: member.userId }]);
  });

  it('refuses a caller without the declared permission, before the worker runs anything', async () => {
    const res = await act('addItem', { label: 'by-outsider' }, outsider.cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('permission_required');
    expect(await rowsLabelled('by-outsider')).toEqual([]);
    expect((await act('nope', {}, member.cookie)).status).toBe(404);
  });

  it('refuses an input the declared schema does not accept', async () => {
    const res = await act('addItem', { label: 'x', extra: true }, member.cookie);
    expect(res.status).toBe(400);
    expect(await rowsLabelled('x')).toEqual([]);
  });

  it('answers an ActionRefusal with its status and code, not 500, and rolls back', async () => {
    const res = await act('addThenRefuse', { label: 'refused' }, member.cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'item_conflicts',
      detail: 'This item conflicts with another.',
    });
    expect(await rowsLabelled('refused')).toEqual([]);
  });

  it('honours only the statuses an inline refusal may answer', async () => {
    expect((await act('refuseOddly', { status: 422 }, member.cookie)).status).toBe(422);
    for (const status of [200, 401, 500]) {
      expect((await act('refuseOddly', { status }, member.cookie)).status).toBe(500);
    }
  });

  it('answers the data API’s own refusal the action let through', async () => {
    // `execute` opens the action, not the collection it writes.
    const rule = ['tenant_member', '*', C, 'create'];
    const e = await getEnforcer();
    await e.removePolicy(...rule);
    await invalidateAllPermissionCaches();
    try {
      const res = await act('caughtThenRethrown', { label: 'member-refused' }, tenantMember.cookie);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('action_data_refused');
      expect(await rowsLabelled('member-refused')).toEqual([]);
    } finally {
      await e.addPolicy(...rule);
      await invalidateAllPermissionCaches();
    }
  });

  it('refuses a collection the action does not declare, and keeps nothing it wrote', async () => {
    for (const mode of ['read', 'write']) {
      const res = await act('sneak', { mode, label: `sneak-${mode}` }, member.cookie);
      expect(res.status).toBe(500);
      expect(await rowsLabelled(`sneak-${mode}`)).toEqual([]);
    }
    expect(await rowsLabelled('sneaked', OTHER)).toEqual([]);
  });

  it('rolls back what the action wrote when it throws', async () => {
    const res = await act('addThenThrow', { label: 'rolled-back' }, member.cookie);
    expect(res.status).toBe(500);
    expect(await rowsLabelled('rolled-back')).toEqual([]);
  });

  it('hands the action the request tenant’s zone, and its own route never answers for it', async () => {
    const res = await act('zone', {}, member.cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: string }).result).toBe(
      await effectiveTimeZone(db, DEFAULT_TENANT_ID),
    );
  });

  // The members of ActionHost the collections tests above do not reach, each over
  // the runner channel: the inline semantics are `ext-action-files.test.ts`.
  it('host.files.read hands the action the bytes of a file the request handed', async () => {
    const actor: FileActor = {
      tenantId: DEFAULT_TENANT_ID,
      principalId: member.userId,
      author: member.userId,
      apiKeyRow: null,
      seesAll: false,
    };
    const made = await asTenant(db, DEFAULT_TENANT_ID, (trx) =>
      storeFile(trx, actor, { name: 'made.txt', bytes: new Uint8Array([5, 5, 5]) }),
    );
    if (!('file' in made)) throw new Error(`fixture refused: ${made.body.error}`);
    const id = made.file.id;
    const res = await act('readFile', { id, $files: { read: [id] } }, member.cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: unknown }).result).toEqual({
      name: 'made.txt',
      bytes: [5, 5, 5],
      isBytes: true,
    });
  });

  it('host.files.put stores the bytes the worker sent, as the caller', async () => {
    const name = `wput-${STAMP}.bin`;
    const res = await act('putFile', { $files: { write: { name, maxBytes: 3 } } }, member.cookie);
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { id: string; name: string; size: number } };
    expect(result).toMatchObject({ name, size: 3 });
    const row = await asEveryTenant(db, (trx) =>
      trx
        .selectFrom('zv_media_files')
        .select(['created_by', 'storage_path'])
        .where('id', '=', result.id)
        .executeTakeFirst(),
    );
    expect(row?.created_by).toBe(member.userId);
    const stored = await getStorage().get(row!.storage_path);
    expect(Array.from(stored?.bytes ?? [])).toEqual([7, 8, 9]);
  });

  it('host.enqueue queues the declared job with the input, once the request commits', async () => {
    const res = await act('queue', { n: 41 }, member.cookie);
    expect(res.status).toBe(200);
    const queued = await sql<{ data: { input?: unknown } }>`
      SELECT data FROM pgboss.job WHERE name = ${jobQueueName(EXT, 'noop')}`.execute(db);
    expect(queued.rows.length).toBe(1);
    expect(JSON.stringify(queued.rows[0]!.data)).toContain('"n":41');
  });

  it('host.actions.run runs a dependency’s action and hands back its result', async () => {
    const res = await act('relay', { label: 'over-the-channel' }, member.cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: unknown }).result).toEqual({
      echoed: 'over-the-channel',
    });
  });

  it('refuses to load when the manifest and the module disagree, in the worker', async () => {
    const action = { name: 'go', permission: { resource: RES }, input: { type: 'object' } };
    const mod = (actions: string) =>
      `export default { name: '${BAD}', actions: { ${actions} }, async register() {} };`;
    await expect(load(BAD, mod(''), { resources: [RES], actions: [action] })).rejects.toThrow(
      'has no implementation',
    );
    await expect(load(BAD, mod('go: async () => null'), { resources: [RES] })).rejects.toThrow(
      'not declared',
    );
  });
});
