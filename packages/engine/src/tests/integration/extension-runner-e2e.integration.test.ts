/**
 * A third-party extension end to end, on a live engine (RFC extension-runner,
 * steps 6–9 and the host-owned transaction).
 *
 * Everything the harness tests prove piece by piece in one process, proved
 * here over HTTP against engines this file starts: an extension that is not in
 * the catalogue as first-party (`is_official: false`, so community), bundled,
 * `engine.isolation: "worker"`, signed as the registry signs (level 2, declared
 * model only: a collection, actions, declared routes — ADR 0056 amendment
 * 2026-11-21), installed and enabled through `/api/marketplace`, called as a
 * member session, an API key and an anonymous webhook sender, then loaded
 * again by a restart. `register()` code and SQL migrations fail the enable.
 *
 * Legs: each driver (`ZVELTIO_DB_DRIVER` bun, pg) × each transport — the
 * default outside production (`process`: no `ZVELTIO_EXT_TRANSPORT` set) and
 * the real runner (container mode: `zveltio ext-runner` as root in Docker,
 * each extension under a uid of its own from 200000, `network_mode: none`,
 * the engine on the host speaking to its socket, as the release compose runs
 * it). The engine stays NODE_ENV=test, so the runner legs name the transport
 * (`ZVELTIO_EXT_TRANSPORT=runner`); that production picks it by default is
 * pinned by worker-extension-runner-default.test.ts. The runner legs need
 * Docker; without it they are skipped by name, and in CI the absence fails.
 *
 * Own engines, not the lane's engine on TEST_PORT: the driver, the
 * transport, `EXTENSIONS_DIR` and the catalogue are boot-time settings.
 *
 *   TEST_DATABASE_URL=postgresql://… bun test \
 *     src/tests/integration/extension-runner-e2e.integration.test.ts
 *   ZVELTIO_E2E_LEGS=bun:process   # one leg, e.g. for a mutation run
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { schemaDigest } from '../../lib/extensions/declared-collections.js';
import { steppedUpFetch } from '../../testing/step-up.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const skipAll = !TEST_DB_URL;
const SFX = String(Date.now()).slice(-6);
const ENGINE_DIR = resolve(import.meta.dir, '../../..');
const REPO_ROOT = resolve(ENGINE_DIR, '../..');
const RUNNER_IMAGE = process.env.ZVELTIO_E2E_RUNNER_IMAGE ?? 'oven/bun:1.3.14';
const RUNNER_UID_BASE = 200_000;
const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';
const PASSWORD = 'E2eRunnerPass123!';
const CRED_HEADERS = [
  'cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'stripe-signature',
] as const;

type Driver = 'bun' | 'pg';
type Transport = 'process' | 'runner';
const ALL_LEGS: Array<[Driver, Transport]> = [
  ['bun', 'process'],
  ['pg', 'process'],
  ['bun', 'runner'],
  ['pg', 'runner'],
];
const wanted = process.env.ZVELTIO_E2E_LEGS?.split(',').map((s) => s.trim());
const LEGS = ALL_LEGS.filter(([d, t]) => !wanted || wanted.includes(`${d}:${t}`));

const hasDocker =
  Bun.spawnSync(['docker', 'info', '--format', '{{.ServerVersion}}'], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;

const code = (d: Driver, t: Transport) => `${d[0]}${t[0]}`;
const mainName = (d: Driver, t: Transport) => `e2em${code(d, t)}${SFX}`;
const inlineName = (d: Driver, t: Transport) => `e2ei${code(d, t)}${SFX}`;
// The surface level 2 lost (ADR 0056 amendment 2026-11-21): `register()` code, SQL migrations.
const legacyName = (d: Driver, t: Transport) => `e2el${code(d, t)}${SFX}`;
const migrName = (d: Driver, t: Transport) => `e2eg${code(d, t)}${SFX}`;
const legacyEntry = (name: string) => `
export default {
  name: '${name}',
  async register(app, ctx) { await ctx.db.query('select 1'); },
};
`;
const emptyEntry = (name: string) => `export default { name: '${name}', async register() {} };\n`;

// Declared model only: a collection, actions, declared routes (ADR 0002, 0039, 0056).
const mainEntry = (main: string, notes: string) => `
const seen = (r) => Object.fromEntries(${JSON.stringify(CRED_HEADERS)}.map((h) => [h, r.headers.get(h)]));
export default {
  name: '${main}',
  actions: {
    addNote: async (input, host) => host.collections.insert('${notes}', input),
    // Writes, then throws: the request transaction takes the write with it.
    addThenThrow: async (input, host) => {
      await host.collections.insert('${notes}', input);
      throw new Error('the action failed after writing');
    },
  },
  routes: {
    env: async () => {
      const p = (await import('node:process')).default;
      return Response.json({ pid: p.pid, uid: p.getuid ? p.getuid() : null });
    },
    notes: async (_request, { host }) => {
      const rows = await host.collections.list('${notes}');
      return Response.json(rows.records.map((r) => r.tag).sort());
    },
    hook: (request) => Response.json(seen(request)),
    declared: async (request, { params, host }) => Response.json({
      id: params.id, url: request.url, body: await request.text(), host: Object.keys(host),
    }),
    mine: () => Response.json({ mine: true }),
  },
  async register() {},
};
`;

function writeExt(
  base: string,
  name: string,
  entry: string,
  extra: Record<string, unknown>,
  worker: boolean,
  files: Record<string, string> = {},
): void {
  const dir = join(base, name);
  mkdirSync(join(dir, 'engine'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      displayName: name,
      version: '1.0.0',
      ...extra,
      engine: {
        entry: 'engine/index.js',
        bundled: true,
        ...(worker ? { isolation: 'worker' } : {}),
      },
    }),
  );
  writeFileSync(join(dir, 'engine', 'index.js'), entry);
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => done(port));
    });
  });
}

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .join('; ');

interface Leg {
  base: string;
  url: string;
  engine: ReturnType<typeof Bun.spawn> | null;
  log: string;
  runner: string | null;
  sockDir: string;
  /** The key `scripts/sign-as-registry.ts` signed the leg's extensions with. */
  registryKeys: string;
}

async function startRunner(leg: Leg): Promise<void> {
  const container = `zv-e2e-runner-${SFX}-${Math.floor(Math.random() * 1e6)}`;
  // Pulled first, so the wait for the socket below is not spent downloading.
  if (Bun.spawnSync(['docker', 'image', 'inspect', RUNNER_IMAGE], { stdout: 'ignore' }).exitCode) {
    const pull = Bun.spawnSync(['docker', 'pull', '-q', RUNNER_IMAGE]);
    if (pull.exitCode !== 0) throw new Error(`docker pull: ${pull.stderr.toString()}`);
  }
  const uid = process.getuid?.() ?? 0;
  const run = Bun.spawnSync([
    'docker',
    'run',
    '-d',
    '--name',
    container,
    '--user',
    '0:0',
    // The image's workdir (/home/bun/app) is closed to a root without CAP_DAC_*,
    // and the runner's spawns fail with EACCES from there.
    '--workdir',
    '/',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    // CHOWN only for the line below; SETUID/SETGID/KILL are the runner's own.
    ...['--cap-add', 'CHOWN', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'KILL'],
    ...['--security-opt', 'no-new-privileges:true', '--pids-limit', '256', '--memory', '1g'],
    ...['-e', 'NODE_ENV=production', '-e', `ZVELTIO_ENGINE_UID=${uid}`],
    ...['-e', 'ZVELTIO_EXT_RUNNER_SOCKET=/run/zveltio-ext/runner.sock'],
    ...['-e', `ZVELTIO_EXT_RUNNER_UID_BASE=${RUNNER_UID_BASE}`],
    ...['-v', `${REPO_ROOT}:/src:ro`, '-v', `${leg.base}:${leg.base}:ro`],
    ...['-v', `${leg.sockDir}:/run/zveltio-ext`],
    RUNNER_IMAGE,
    'sh',
    '-c',
    // The runner refuses a socket directory that is not root's (closeSharedDirs).
    'chown 0:0 /run/zveltio-ext && exec bun /src/packages/engine/src/binary-entry.ts ext-runner',
  ]);
  if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr.toString()}`);
  leg.runner = container;
  const sock = join(leg.sockDir, 'runner.sock');
  for (let i = 0; i < 100; i++) {
    if (Bun.spawnSync(['test', '-S', sock]).exitCode === 0) return;
    await Bun.sleep(200);
  }
  const logs = Bun.spawnSync(['docker', 'logs', container]);
  throw new Error(`the runner did not listen: ${logs.stdout}${logs.stderr}`);
}

function stopRunner(leg: Leg): void {
  if (!leg.runner) return;
  const uid = process.getuid?.() ?? 0;
  // Hand the directory back so the temp dir can be removed without root.
  Bun.spawnSync([
    'docker',
    'exec',
    leg.runner,
    'sh',
    '-c',
    `rm -f /run/zveltio-ext/*; chown ${uid} /run/zveltio-ext`,
  ]);
  Bun.spawnSync(['docker', 'rm', '-f', leg.runner], { stdout: 'ignore', stderr: 'ignore' });
  leg.runner = null;
}

async function bootEngine(leg: Leg, driver: Driver, transport: Transport): Promise<void> {
  const port = await freePort();
  leg.url = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    DATABASE_URL: TEST_DB_URL!,
    ZVELTIO_DB_DRIVER: driver,
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ?? 'ci-test-secret-minimum-32-characters-long',
    BETTER_AUTH_URL: leg.url,
    FIELD_ENCRYPTION_KEY: '0'.repeat(64),
    NODE_ENV: 'test',
    PORT: String(port),
    ZVELTIO_REGISTRATION_ENABLED: '1',
    ZVELTIO_REGISTRY_URL: 'http://127.0.0.1:9',
    EXTENSIONS_DIR: leg.base,
    REGISTRY_PUBLIC_KEYS_JSON: leg.registryKeys,
    STORAGE_LOCAL_DIR: join(leg.base, '.storage'),
    DB_POOL_MAX: '10',
  };
  // The process legs set nothing: the default transport is what they test.
  if (transport === 'runner') {
    env.ZVELTIO_EXT_TRANSPORT = 'runner';
    env.ZVELTIO_EXT_RUNNER_SOCKET = join(leg.sockDir, 'runner.sock');
  }
  // exec: the pid is the engine's, which the extension's own must differ from.
  leg.engine = Bun.spawn(['sh', '-c', 'exec bun src/index.ts >"$1" 2>&1', 'sh', leg.log], {
    cwd: ENGINE_DIR,
    env,
  });
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${leg.url}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    if (leg.engine.exitCode !== null) break;
    await Bun.sleep(500);
  }
  throw new Error(`engine (${driver}) did not start; log: ${leg.log}`);
}

type Res = { status: number; body: unknown };

// One pool for every leg: initDatabase() opens a new one on each call, and four
// of them beside four engines ran Postgres out of connections.
let shared: Database | null = null;
async function testDb(): Promise<Database> {
  if (shared) return shared;
  process.env.DATABASE_URL = TEST_DB_URL!;
  const { initDatabase } = await import('../../db/index.js');
  shared = await initDatabase();
  return shared;
}
afterAll(async () => {
  await shared?.destroy().catch(() => undefined);
});

for (const [driver, transport] of LEGS) {
  const main = mainName(driver, transport);
  const twin = inlineName(driver, transport);
  const legacy = legacyName(driver, transport);
  const migr = migrName(driver, transport);
  const extras = [twin, legacy, migr];
  // Declared by the extension, created and owned by the engine at enable (ADR 0012).
  const notes = `${main}_notes`;
  const table = `zvd_${notes}`;
  const skipLeg = skipAll || (transport === 'runner' && !hasDocker);

  describe.skipIf(skipLeg)(`third-party extension e2e — driver ${driver}, ${transport}`, () => {
    let db: Database;
    const leg: Leg = {
      base: '',
      url: '',
      engine: null,
      log: '',
      runner: null,
      sockDir: '',
      registryKeys: '',
    };
    const out: Record<string, unknown> = {};
    const db$ = async <T>(q: ReturnType<typeof sql<T>>) => (await q.execute(db)).rows;

    beforeAll(async () => {
      db = await testDb();

      leg.base = mkdtempSync(join(tmpdir(), 'zv-e2e-ext-'));
      // Outside the leg's directory, which afterAll removes: the log outlives a
      // failure (CI prints it), and the next run of the leg overwrites it.
      leg.log = join(tmpdir(), `zv-e2e-engine-${code(driver, transport)}.log`);
      // Not inside the extensions' directory: the runner makes it root's, and
      // the engine closes every entry there before each spawn (ADR 0062, F15).
      leg.sockDir = mkdtempSync(join(tmpdir(), 'zv-e2e-sock-'));
      const schema = JSON.stringify({ name: notes, fields: [{ name: 'tag', type: 'text' }] });
      writeExt(
        leg.base,
        main,
        mainEntry(main, notes),
        {
          collections: [notes],
          permissions: ['data:write'],
          integrity: {
            schemaSha256: schemaDigest(
              new Map([[`collections/${notes}.json`, new TextEncoder().encode(schema)]]),
            ),
          },
          actions: [
            {
              name: 'addNote',
              permission: { resource: notes, action: 'create' },
              input: { type: 'object', properties: { tag: { type: 'string' } } },
              writes: [notes],
            },
            {
              name: 'addThenThrow',
              permission: { resource: notes, action: 'create' },
              input: { type: 'object', properties: { tag: { type: 'string' } } },
              writes: [notes],
            },
          ],
          routes: [
            { method: 'GET', path: '/env', access: 'caller', handler: 'env' },
            { method: 'GET', path: '/notes', access: 'caller', handler: 'notes' },
            { method: 'POST', path: '/hook', access: 'public', handler: 'hook' },
            { method: 'POST', path: '/declared/:id', access: 'public', handler: 'declared' },
            { method: 'GET', path: '/declared/mine', access: 'caller', handler: 'mine' },
          ],
          apiKeyRoutes: ['GET /notes'],
        },
        true,
        { [`schema/collections/${notes}.json`]: schema },
      );
      // The same publisher, the same declared model, without worker isolation.
      writeExt(leg.base, twin, emptyEntry(twin), {}, false);
      writeExt(leg.base, legacy, legacyEntry(legacy), {}, true);
      writeExt(leg.base, migr, emptyEntry(migr), {}, true, {
        'engine/migrations/001_init.sql': `CREATE TABLE zv_${migr}_log (id serial PRIMARY KEY);\n`,
      });
      // Not first-party: in the catalogue with is_official false, as the
      // registry lists a community submission.
      writeFileSync(
        join(leg.base, 'catalog.json'),
        JSON.stringify({
          catalog_version: 'e2e',
          entries: [main, ...extras].map((name) => ({
            name,
            displayName: name,
            category: 'other',
            version: '1.0.0',
            author: 'someone-else',
            description: 'e2e third-party fixture',
            is_official: false,
            publisher_tier: 'community',
          })),
        }),
      );
      // Signed as a registry download leaves them (level 2): an unsigned
      // directory never runs (ADR 0056 amendment 2026-11-18).
      const signed = Bun.spawnSync([
        'bun',
        join(REPO_ROOT, 'scripts', 'sign-as-registry.ts'),
        leg.base,
        main,
        ...extras,
      ]);
      if (signed.exitCode !== 0) throw new Error(`sign-as-registry: ${signed.stderr.toString()}`);
      leg.registryKeys = signed.stdout
        .toString()
        .trim()
        .replace(/^REGISTRY_PUBLIC_KEYS_JSON=/, '');
      // The runner's uids read no bundle: the engine sends the bytes (ADR 0062, F15).
      chmodSync(leg.sockDir, 0o755);

      if (transport === 'runner') await startRunner(leg);
      await bootEngine(leg, driver, transport);
      const api = (path: string, init: RequestInit = {}) => fetch(`${leg.url}${path}`, init);
      const json = { 'content-type': 'application/json' };

      // A god (one per instance: the previous holder stands down) and a member.
      const signUp = async (email: string) => {
        const r = await api('/api/auth/sign-up/email', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ email, password: PASSWORD, name: email }),
        });
        const b = (await r.json()) as { user?: { id: string } };
        if (!b.user?.id) throw new Error(`sign-up ${email}: ${r.status} ${JSON.stringify(b)}`);
        return b.user.id;
      };
      const signIn = async (email: string) =>
        cookieOf(
          await api('/api/auth/sign-in/email', {
            method: 'POST',
            headers: json,
            body: JSON.stringify({ email, password: PASSWORD }),
          }),
        );
      const godEmail = `e2e-god-${code(driver, transport)}-${SFX}@test.local`;
      const memberEmail = `e2e-member-${code(driver, transport)}-${SFX}@test.local`;
      const godId = await signUp(godEmail);
      const memberId = await signUp(memberEmail);
      out.memberId = memberId;
      out.godId = godId;
      await db$(sql`UPDATE "user" SET role = 'member' WHERE role = 'god'`);
      await db$(sql`UPDATE "user" SET role = 'god' WHERE id = ${godId}`);
      await db$(sql`UPDATE "user" SET role = 'member' WHERE id = ${memberId}`);
      await db$(sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, valid_from)
                    VALUES (${DEFAULT_TENANT}::uuid, ${memberId}, 'member', now() - interval '2 days')
                    ON CONFLICT (tenant_id, user_id) DO UPDATE SET valid_to = NULL`);
      const god = { cookie: await signIn(godEmail) };
      const member = { cookie: await signIn(memberEmail) };
      // Extension mutations need a step-up (lib/step-up.ts): a soft passkey.
      const godApi = await steppedUpFetch(leg.url, god.cookie, PASSWORD);
      const asGod = (path: string, method = 'GET', body?: unknown) =>
        godApi(path, {
          method,
          headers: { ...god, ...json },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });

      // Install and enable, through the marketplace.
      for (const name of [main, ...extras]) {
        const ins = await asGod(`/api/marketplace/${name}/install`, 'POST', {});
        const en = await asGod(`/api/marketplace/${name}/enable`, 'POST', {});
        out[`install:${name}`] = ins.status;
        out[`enable:${name}`] = { status: en.status, body: await en.json().catch(() => null) };
      }
      out.migrTable = (
        await db$(sql<{ t: string | null }>`SELECT to_regclass(${`zv_${migr}_log`})::text AS t`)
      )[0]?.t;
      // The member may read and create the collection the extension declared.
      for (const action of ['read', 'create']) {
        const g = await asGod('/api/permissions/policies', 'POST', {
          subject: memberId,
          resource: notes,
          action,
        });
        if (!g.ok) throw new Error(`grant: ${g.status} ${await g.text()}`);
      }
      const key = (await (
        await asGod('/api/api-keys', 'POST', {
          name: `e2e-${main}`,
          scopes: [
            { collection: `$ext:${main}`, actions: ['read', 'create'] },
            { collection: notes, actions: ['read'] },
          ],
        })
      ).json()) as { id: string; key: string };
      out.keyId = key.id;
      const asKey = { 'x-api-key': key.key };

      const call = async (
        path: string,
        headers: Record<string, string>,
        method = 'GET',
        body?: unknown,
      ): Promise<Res> => {
        const r = await api(`/ext/${main}${path}`, {
          method,
          headers: { ...headers, ...(body ? json : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await r.text();
        try {
          return { status: r.status, body: JSON.parse(text) };
        } catch {
          return { status: r.status, body: text };
        }
      };
      const authors = async () =>
        Object.fromEntries(
          (
            await db$(
              sql<{ tag: string; by: string | null }>`SELECT tag, created_by AS by
                                                    FROM ${sql.table(table)}`,
            )
          ).map((r) => [r.tag, r.by]),
        );

      out.enginePid = leg.engine?.pid;
      out.env = await call('/env', member);
      out.addNote = (await call('/actions/addNote', member, 'POST', { tag: 's' })).status;
      out.addThenThrow = (await call('/actions/addThenThrow', member, 'POST', { tag: 'x' })).status;
      out.authors = await authors();
      out.notesSession = await call('/notes', member);
      out.notesKey = await call('/notes', asKey);
      // A route the manifest did not open to keys.
      out.keyUndeclared = (await call('/actions/addNote', asKey, 'POST', { tag: 'k' })).status;

      const creds = {
        cookie: member.cookie,
        authorization: 'Bearer caller-token',
        'proxy-authorization': 'Basic cHJveHk6cHc=',
        'x-api-key': key.key,
        'stripe-signature': 't=1,v1=abc',
      };
      out.hook = await call('/hook', creds, 'POST');
      out.declaredPublic = await call('/declared/7', {}, 'POST', { n: 1 });
      out.declaredMineAnon = (await call('/declared/mine', {})).status;
      out.declaredMine = await call('/declared/mine', member);
      out.declaredUndeclared = (await call('/declared/7', member)).status;

      // Every assignment of the member in the default tenant lapses.
      await db$(sql`UPDATE zv_tenant_users SET valid_to = now() - interval '1 day'
                    WHERE tenant_id = ${DEFAULT_TENANT}::uuid AND user_id = ${memberId}`);
      out.notesLapsed = (await call('/notes', member)).status;
      out.addLapsed = (await call('/actions/addNote', member, 'POST', { tag: 'l' })).status;
      out.authorsLapsed = await authors();
      // Back in force, so the restart below is asked of a member again.
      await db$(sql`UPDATE zv_tenant_users SET valid_to = NULL
                    WHERE tenant_id = ${DEFAULT_TENANT}::uuid AND user_id = ${memberId}`);

      // A restart: the enabled extensions load at boot, on the same transport.
      leg.engine?.kill();
      await leg.engine?.exited;
      await bootEngine(leg, driver, transport);
      out.enginePidAfterRestart = leg.engine?.pid;
      out.envAfterRestart = await call('/env', member);
      out.notesAfterRestart = await call('/notes', asKey);
    }, 240_000);

    afterAll(async () => {
      leg.engine?.kill();
      await leg.engine?.exited;
      stopRunner(leg);
      if (db) {
        const { revokeExtensionDbRoles } = await import('../../lib/extensions/ext-db-role.js');
        for (const name of [main, ...extras]) {
          await db$(sql`DELETE FROM zv_extension_registry WHERE name = ${name}`);
          await db$(sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${name}%`}`).catch(
            () => undefined,
          );
          await revokeExtensionDbRoles(db, name, true).catch(() => undefined);
        }
        await db$(sql`DROP TABLE IF EXISTS ${sql.table(`zv_${migr}_log`)}`);
        const { dropTestCollection } = await import('../../testing/app-harness.js');
        await dropTestCollection(db, notes).catch(() => undefined);
        if (out.keyId) await db$(sql`DELETE FROM zv_api_keys WHERE id = ${out.keyId as string}`);
        // Dropping a collection leaves its grants behind (the member's and the
        // role defaults the engine seeds on create); then the two accounts.
        await db$(sql`DELETE FROM zvd_permissions
                      WHERE v0 = ${out.memberId as string} OR v2 = ${notes}`);
        await db$(sql`DELETE FROM zv_tenant_users WHERE user_id = ${out.memberId as string}`);
        await db$(
          sql`DELETE FROM "user" WHERE id IN (${out.memberId as string}, ${out.godId as string})`,
        ).catch(() => undefined);
      }
      if (leg.base) rmSync(leg.base, { recursive: true, force: true });
      if (leg.sockDir) rmSync(leg.sockDir, { recursive: true, force: true });
    }, 60_000);

    it('a community extension installs and enables only in worker isolation', () => {
      expect(out[`install:${main}`]).toBe(200);
      expect(out[`enable:${main}`]).toMatchObject({ status: 200, body: { success: true } });
      expect(out[`enable:${twin}`]).toMatchObject({ status: 422 });
      expect(JSON.stringify(out[`enable:${twin}`])).toContain('must run in worker isolation');
    });

    it('level 2 is declared model only: register() code and SQL migrations fail the enable', () => {
      expect(out[`enable:${legacy}`]).toMatchObject({ status: 422 });
      expect(JSON.stringify(out[`enable:${legacy}`])).toMatch(
        /register\(\) used ctx\.db: .*declared model only/,
      );
      expect(out[`enable:${migr}`]).toMatchObject({ status: 422 });
      expect(JSON.stringify(out[`enable:${migr}`])).toContain(
        'declared model only: declare its collections',
      );
      expect(out.migrTable).toBeNull();
    });

    it(`runs out of the engine process (${transport})`, () => {
      const env = out.env as { status: number; body: { pid: number; uid: number } };
      expect(env.status).toBe(200);
      expect(env.body.pid).not.toBe(out.enginePid);
      if (transport === 'runner') expect(env.body.uid).toBeGreaterThanOrEqual(RUNNER_UID_BASE);
      else expect(env.body.uid).toBe(process.getuid?.() ?? -1);
    });

    it('loads again at boot after a restart, on the same transport', () => {
      const env = out.envAfterRestart as { status: number; body: { pid: number; uid: number } };
      expect(env.status).toBe(200);
      expect(env.body.pid).not.toBe(out.enginePidAfterRestart);
      if (transport === 'runner') expect(env.body.uid).toBeGreaterThanOrEqual(RUNNER_UID_BASE);
      expect(out.notesAfterRestart).toEqual({ status: 200, body: ['s'] });
    });

    it('an action writes its declared collection as the caller, in the request transaction', () => {
      expect(out.addNote).toBe(200);
      expect(out.addThenThrow).toBe(500);
      expect(out.authors).toEqual({ s: out.memberId });
    });

    it('a declared route reads its collection as the caller: session and API key', () => {
      expect(out.notesSession).toEqual({ status: 200, body: ['s'] });
      expect(out.notesKey).toEqual({ status: 200, body: ['s'] });
      // A valid key on a route not in `apiKeyRoutes` is refused as a session-only route.
      expect(out.keyUndeclared).toBe(403);
    });

    it('the caller credentials are stripped from what reaches the worker', () => {
      expect(out.hook).toEqual({
        status: 200,
        body: {
          cookie: null,
          authorization: null,
          'proxy-authorization': null,
          'x-api-key': null,
          'stripe-signature': 't=1,v1=abc',
        },
      });
    });

    it('a declared route is served over the transport (ADR 0039)', () => {
      expect(out.declaredPublic).toMatchObject({
        status: 200,
        body: { id: '7', body: '{"n":1}', host: ['collections', 'identity'] },
      });
      expect(String(((out.declaredPublic as Res).body as { url: string }).url)).toEndWith(
        `/ext/${main}/declared/7`,
      );
      expect(out.declaredMineAnon).toBe(401);
      expect(out.declaredMine).toEqual({ status: 200, body: { mine: true } });
      expect(out.declaredUndeclared).toBe(404);
    });

    it('a lapsed tenant member reads nothing and writes nothing (migration 060)', () => {
      // Refused at the door, in the default tenant too: every assignment lapsed
      // (tenant-default-withdrawal.test.ts).
      expect(out.notesLapsed).toBe(403);
      expect(out.addLapsed).toBe(403);
      expect(out.authorsLapsed).toEqual({ s: out.memberId });
    });
  });
}

describe.skipIf(skipAll)('third-party extension e2e — the runner legs ran', () => {
  it('CI has Docker for the runner legs', () => {
    if (process.env.CI) expect(hasDocker).toBe(true);
  });
});
