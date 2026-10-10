/**
 * A third-party extension end to end, on a live engine (RFC extension-runner,
 * steps 6–9 and the host-owned transaction).
 *
 * Everything the harness tests prove piece by piece in one process, proved
 * here over HTTP against engines this file starts: an extension that is not in
 * the catalogue as first-party (`is_official: false`, so community), bundled,
 * `engine.isolation: "worker"`, installed and enabled through
 * `/api/marketplace`, called as a member session, an API key and an
 * anonymous webhook sender, then loaded again by a restart.
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
const depName = (d: Driver, t: Transport) => `e2ed${code(d, t)}${SFX}`;
const inlineName = (d: Driver, t: Transport) => `e2ei${code(d, t)}${SFX}`;
// Listen where a worker may not: an extension it did not declare, an engine event.
const strangerName = (d: Driver, t: Transport) => `e2es${code(d, t)}${SFX}`;
const recordName = (d: Driver, t: Transport) => `e2er${code(d, t)}${SFX}`;
const listenerEntry = (name: string, event: string) => `
export default {
  name: '${name}',
  async register(app, ctx) { ctx.events.on('${event}', () => {}); },
};
`;
const collName = (d: Driver, t: Transport) => `e2ec_${code(d, t)}_${SFX}`;

// The dependency: a service, an event it emits, and a call it was never allowed.
const depEntry = (dep: string, main: string) => `
export default {
  name: '${dep}',
  async register(app, ctx) {
    ctx.services.register('${dep}.echo', (x) => ({ echoed: x }));
    app.post('/tick', async (c) => {
      await ctx.events.emitAsync('${dep}.tick', { from: '${dep}' });
      return c.json({ ok: true });
    });
    app.get('/call-main', async (c) => {
      try { return c.json({ out: await ctx.services.get('${main}.double')(2) }); }
      catch (e) { return c.json({ error: e.message }); }
    });
  },
};
`;

const mainEntry = (main: string, dep: string, table: string, res: string) => `
const T = (s) => 'zv_${main}_' + s;
const mark = (db, tag) => db.insertInto(T('log')).values({ tag }).execute();
// A host-owned transaction outside any request: one that commits, one that throws.
const pair = async (db, where) => {
  await db.transaction().execute(async (trx) => { await mark(trx, where + '-keep'); });
  try {
    await db.transaction().execute(async (trx) => { await mark(trx, where + '-drop'); throw new Error('no'); });
  } catch {}
};
const seen = (c) => Object.fromEntries(${JSON.stringify(CRED_HEADERS)}.map((h) => [h, c.req.header(h) ?? null]));
let ping = null;
let tick = null;
export default {
  name: '${main}',
  async register(app, ctx) {
    const db = ctx.db;
    await pair(db, 'register');
    setTimeout(() => { pair(db, 'timer').catch((e) => console.error('timer pair', e.message)); }, 0);
    ctx.services.register('${main}.double', (n) => n * 2);
    // Outside its own namespace: the host refuses it, so nothing answers the name.
    ctx.services.register('${dep}.squat', () => 'squatted');
    ctx.events.on('${main}.ping', (p) => { ping = p; });
    ctx.events.on('${dep}.tick', (p) => { tick = p; });
    ctx.events.on('${main}.txn', async () => { await pair(db, 'event'); });

    app.get('/env', async (c) => {
      const p = (await import('node:process')).default;
      return c.json({ pid: p.pid, uid: p.getuid ? p.getuid() : null });
    });
    app.get('/who', async (c) => {
      const s = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
      return c.json({ user: c.get('user')?.id ?? null, session: s?.user?.id ?? null });
    });
    app.get('/perm', async (c) => c.json({
      read: await ctx.checkPermission(c.get('user').id, '${res}', 'read'),
      del: await ctx.checkPermission(c.get('user').id, '${res}', 'delete'),
    }));
    app.get('/as', async (c) =>
      c.json({ other: await ctx.checkPermission(c.req.query('id'), '${res}', 'read') }));
    app.post('/notes', async (c) => {
      const { tag } = await c.req.json();
      await db.insertInto(T('notes')).values({ tag, tags: ['a', 'b'] }).execute();
      return c.json({ ok: true }, 201);
    });
    app.get('/notes', async (c) =>
      c.json(await db.selectFrom(T('notes')).select(['tag', 'tags']).orderBy('id').execute()));
    app.post('/crud', async (c) => {
      const [made] = await db.insertInto('${table}').values({ title: 'crud' }).returning('id').execute();
      const read = await db.selectFrom('${table}').select('title').where('id', '=', made.id).execute();
      const u = await db.updateTable('${table}').set({ title: 'crud2' }).where('id', '=', made.id).executeTakeFirst();
      const after = await db.selectFrom('${table}').select('title').where('id', '=', made.id).executeTakeFirst();
      const d = await db.deleteFrom('${table}').where('id', '=', made.id).executeTakeFirst();
      return c.json({ read, updated: Number(u.numUpdatedRows), after: after?.title ?? null, deleted: Number(d.numDeletedRows) });
    });
    app.get('/rows', async (c) =>
      c.json((await db.selectFrom('${table}').select('title').execute()).length));
    app.post('/touch', async (c) => {
      const u = await db.updateTable('${table}').set({ title: 'touched' }).executeTakeFirst();
      const d = await db.deleteFrom('${table}').executeTakeFirst();
      return c.json({ updated: Number(u.numUpdatedRows), deleted: Number(d.numDeletedRows) });
    });
    app.post('/add', async (c) => {
      try { await db.insertInto('${table}').values({ title: 'added' }).execute(); return c.json({ added: true }); }
      catch (e) { return c.json({ added: false, errno: e.errno ?? null, error: e.message }); }
    });
    // Inside a request: a savepoint rolled back keeps the outer work...
    app.post('/txn-inner', async (c) => {
      await mark(db, 'req-outer');
      try {
        await db.transaction().execute(async (trx) => { await mark(trx, 'req-inner'); throw new Error('inner'); });
      } catch {}
      return c.json({ ok: true });
    });
    // ...and a handler that throws takes the whole request with it.
    app.post('/txn-throw', async () => {
      await mark(db, 'req-thrown');
      throw new Error('handler failed');
    });
    app.post('/emit-own', async (c) => {
      ping = null;
      await ctx.events.emitAsync('${main}.ping', { n: 7 });
      return c.json({ ping });
    });
    app.post('/emit-engine', async (c) => {
      try { await ctx.events.emitAsync('record.created', { collection: 'x', id: '1' }); return c.json({ emitted: true }); }
      catch (e) { return c.json({ emitted: false, error: e.message }); }
    });
    app.post('/emit-txn', async (c) => {
      await ctx.events.emitAsync('${main}.txn', {});
      return c.json({ ok: true });
    });
    app.get('/tick', (c) => c.json({ tick }));
    app.get('/svc/:name', async (c) => {
      try { return c.json({ out: await ctx.services.get(c.req.param('name'))('x') }); }
      catch (e) { return c.json({ error: e.message }); }
    });
    app.post('/hook', (c) => c.json(seen(c)));
    app.post('/fwd', (c) => c.json(seen(c)));
  },
};
`;

const mainMigration = (main: string) =>
  [
    `CREATE TABLE IF NOT EXISTS zv_${main}_notes (id serial PRIMARY KEY, tag text UNIQUE, tags text[]);`,
    `CREATE TABLE IF NOT EXISTS zv_${main}_log (id serial PRIMARY KEY, tag text NOT NULL);`,
    '-- DOWN',
    `DROP TABLE IF EXISTS zv_${main}_log;`,
    `DROP TABLE IF EXISTS zv_${main}_notes;`,
  ].join('\n');

function writeExt(
  base: string,
  name: string,
  entry: string,
  extra: Record<string, unknown>,
  worker: boolean,
  migration?: string,
): void {
  const dir = join(base, name);
  mkdirSync(join(dir, 'engine', 'migrations'), { recursive: true });
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
  // A worker's migrations are read from engine/migrations (load.ts), not its code.
  writeFileSync(join(dir, 'engine', 'index.js'), entry);
  if (migration) writeFileSync(join(dir, 'engine', 'migrations', '001_init.sql'), migration);
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
    REGISTRY_URL: 'http://127.0.0.1:9',
    EXTENSIONS_DIR: leg.base,
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
  const dep = depName(driver, transport);
  const twin = inlineName(driver, transport);
  const stranger = strangerName(driver, transport);
  const recorder = recordName(driver, transport);
  const extras = [twin, stranger, recorder];
  const coll = collName(driver, transport);
  const table = `zvd_${coll}`;
  // What checkPermission is asked about: the member may read it, not delete it.
  const res = `${coll}_res`;
  const skipLeg = skipAll || (transport === 'runner' && !hasDocker);

  describe.skipIf(skipLeg)(`third-party extension e2e — driver ${driver}, ${transport}`, () => {
    let db: Database;
    const leg: Leg = { base: '', url: '', engine: null, log: '', runner: null, sockDir: '' };
    const out: Record<string, unknown> = {};
    const db$ = async <T>(q: ReturnType<typeof sql<T>>) => (await q.execute(db)).rows;
    const logged = async (tag: string) =>
      Number(
        (
          await db$(
            sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(`zv_${main}_log`)}
                               WHERE tag = ${tag}`,
          )
        )[0]?.n,
      );

    beforeAll(async () => {
      db = await testDb();

      leg.base = mkdtempSync(join(tmpdir(), 'zv-e2e-ext-'));
      // Outside the leg's directory, which afterAll removes: the log outlives a
      // failure (CI prints it), and the next run of the leg overwrites it.
      leg.log = join(tmpdir(), `zv-e2e-engine-${code(driver, transport)}.log`);
      leg.sockDir = join(leg.base, '.sock');
      mkdirSync(leg.sockDir);
      writeExt(leg.base, dep, depEntry(dep, main), {}, true);
      writeExt(
        leg.base,
        main,
        mainEntry(main, dep, table, res),
        {
          dependencies: [{ name: dep }],
          publicRoutes: ['/hook', '/fwd'],
          forwardCredentials: { '/fwd': ['authorization'] },
          apiKeyRoutes: ['GET /who', 'GET /perm', 'GET /notes', 'POST /notes'],
        },
        true,
        mainMigration(main),
      );
      // The same publisher, the same bundle, without worker isolation.
      writeExt(leg.base, twin, depEntry(twin, main), {}, false);
      writeExt(leg.base, stranger, listenerEntry(stranger, `${dep}.tick`), {}, true);
      writeExt(leg.base, recorder, listenerEntry(recorder, 'record.created'), {}, true);
      // Not first-party: in the catalogue with is_official false, as the
      // registry lists a community submission.
      writeFileSync(
        join(leg.base, 'catalog.json'),
        JSON.stringify({
          catalog_version: 'e2e',
          entries: [dep, main, ...extras].map((name) => ({
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
      // The runner's uids read the bundles.
      Bun.spawnSync(['chmod', '-R', 'a+rX', leg.base]);
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
      const asGod = (path: string, method = 'GET', body?: unknown) =>
        api(path, {
          method,
          headers: { ...god, ...json },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });

      // A tenant collection (RLS on tenant_id), two rows, the member may read it.
      const made = await asGod('/api/collections', 'POST', {
        name: coll,
        fields: [{ name: 'title', type: 'text' }],
      });
      if (made.status >= 300) throw new Error(`collection: ${made.status} ${await made.text()}`);
      for (let i = 0; i < 60; i++) {
        const [r] = await db$(
          sql<{ rls: boolean | null }>`SELECT relforcerowsecurity AS rls FROM pg_class
                                       WHERE oid = to_regclass(${table})`,
        );
        if (r?.rls) break;
        await Bun.sleep(250);
      }
      const seed = () =>
        db$(sql`DELETE FROM ${sql.table(table)}`).then(() =>
          db$(sql`INSERT INTO ${sql.table(table)} (title, tenant_id)
                  VALUES ('a', ${DEFAULT_TENANT}::uuid), ('b', ${DEFAULT_TENANT}::uuid)`),
        );
      await seed();
      const grants: Array<[string, string]> = [
        [res, 'read'],
        ...['read', 'create', 'update', 'delete'].map((a): [string, string] => [coll, a]),
      ];
      for (const [resource, action] of grants) {
        const g = await asGod('/api/permissions/policies', 'POST', {
          subject: memberId,
          resource,
          action,
        });
        if (!g.ok) throw new Error(`grant: ${g.status} ${await g.text()}`);
      }

      // Install and enable, through the marketplace, the dependency first.
      for (const name of [dep, main, ...extras]) {
        const ins = await asGod(`/api/marketplace/${name}/install`, 'POST', {});
        const en = await asGod(`/api/marketplace/${name}/enable`, 'POST', {});
        out[`install:${name}`] = ins.status;
        out[`enable:${name}`] = { status: en.status, body: await en.json().catch(() => null) };
      }
      const key = (await (
        await asGod('/api/api-keys', 'POST', {
          name: `e2e-${main}`,
          scopes: [{ collection: `$ext:${main}`, actions: ['read', 'create'] }],
        })
      ).json()) as { id: string; key: string };
      out.keyId = key.id;
      const asKey = { 'x-api-key': key.key };

      const call = async (
        path: string,
        headers: Record<string, string>,
        method = 'GET',
        body?: unknown,
        ext = main,
      ): Promise<Res> => {
        const r = await api(`/ext/${ext}${path}`, {
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

      out.enginePid = leg.engine?.pid;
      out.env = await call('/env', member);
      out.whoSession = await call('/who', member);
      out.whoKey = await call('/who', asKey);
      // A route the manifest did not open to keys.
      out.keyUndeclared = (await call('/crud', asKey, 'POST')).status;
      out.permSession = await call('/perm', member);
      out.permKey = await call('/perm', asKey);
      out.asGod = await call(`/as?id=${encodeURIComponent(godId)}`, member);
      out.notesSession = await call('/notes', member, 'POST', { tag: 's' });
      out.notesKey = await call('/notes', asKey, 'POST', { tag: 'k' });
      out.notesRead = await call('/notes', asKey);
      out.crud = await call('/crud', member, 'POST');

      out.txnInner = await call('/txn-inner', member, 'POST');
      out.txnThrow = (await call('/txn-throw', member, 'POST')).status;
      out.emitTxn = await call('/emit-txn', member, 'POST');
      await Bun.sleep(300);
      for (const t of [
        'req-outer',
        'req-inner',
        'req-thrown',
        'register-keep',
        'register-drop',
        'timer-keep',
        'timer-drop',
        'event-keep',
        'event-drop',
      ]) {
        out[`log:${t}`] = await logged(t);
      }

      out.emitOwn = await call('/emit-own', member, 'POST');
      out.emitEngine = await call('/emit-engine', member, 'POST');
      out.depTick = await call('/tick', member, 'POST', undefined, dep);
      out.tick = await call('/tick', member);
      out.svcDep = await call(`/svc/${dep}.echo`, member);
      out.svcSquat = await call(`/svc/${dep}.squat`, member);
      out.svcUndeclared = await call('/call-main', member, 'GET', undefined, dep);

      const creds = {
        cookie: member.cookie,
        authorization: 'Bearer caller-token',
        'proxy-authorization': 'Basic cHJveHk6cHc=',
        'x-api-key': key.key,
        'stripe-signature': 't=1,v1=abc',
      };
      out.hook = await call('/hook', creds, 'POST');
      out.fwd = await call('/fwd', creds, 'POST');

      out.rowsInForce = await call('/rows', member);
      out.addInForce = await call('/add', member, 'POST');
      // Every assignment of the member in the default tenant lapses.
      await db$(sql`UPDATE zv_tenant_users SET valid_to = now() - interval '1 day'
                    WHERE tenant_id = ${DEFAULT_TENANT}::uuid AND user_id = ${memberId}`);
      await seed();
      out.rowsLapsed = await call('/rows', member);
      out.touchLapsed = await call('/touch', member, 'POST');
      out.addLapsed = await call('/add', member, 'POST');
      const [counts] = await db$(
        sql<{ added: number; left: number }>`SELECT
           count(*) FILTER (WHERE title = 'added')::int AS added,
           count(*) FILTER (WHERE title IN ('a', 'b'))::int AS left
           FROM ${sql.table(table)}`,
      );
      out.lapsedCounts = counts;

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
        for (const name of [main, dep, ...extras]) {
          await db$(sql`DELETE FROM zv_extension_registry WHERE name = ${name}`);
          await db$(sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${name}%`}`).catch(
            () => undefined,
          );
          await revokeExtensionDbRoles(db, name, true).catch(() => undefined);
        }
        await db$(sql`DROP TABLE IF EXISTS ${sql.table(`zv_${main}_notes`)}`);
        await db$(sql`DROP TABLE IF EXISTS ${sql.table(`zv_${main}_log`)}`);
        const { dropTestCollection } = await import('../../testing/app-harness.js');
        await dropTestCollection(db, coll).catch(() => undefined);
        if (out.keyId) await db$(sql`DELETE FROM zv_api_keys WHERE id = ${out.keyId as string}`);
        // Dropping a collection leaves its grants behind (the member's and the
        // role defaults the engine seeds on create); then the two accounts.
        await db$(sql`DELETE FROM zvd_permissions
                      WHERE v0 = ${out.memberId as string} OR v2 IN (${coll}, ${res})`);
        await db$(sql`DELETE FROM zv_tenant_users WHERE user_id = ${out.memberId as string}`);
        await db$(
          sql`DELETE FROM "user" WHERE id IN (${out.memberId as string}, ${out.godId as string})`,
        ).catch(() => undefined);
      }
      if (leg.base) rmSync(leg.base, { recursive: true, force: true });
    }, 60_000);

    it('a community extension installs and enables only in worker isolation', () => {
      for (const name of [dep, main]) {
        expect(out[`install:${name}`]).toBe(200);
        expect(out[`enable:${name}`]).toMatchObject({ status: 200, body: { success: true } });
      }
      expect(out[`enable:${twin}`]).toMatchObject({ status: 422 });
      expect(JSON.stringify(out[`enable:${twin}`])).toContain('must run in worker isolation');
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
      expect(out.notesAfterRestart).toMatchObject({
        status: 200,
        body: [{ tag: 's' }, { tag: 'k' }],
      });
    });

    it('auth: the request principal, session and API key', () => {
      expect(out.whoSession).toEqual({
        status: 200,
        body: { user: out.memberId, session: out.memberId },
      });
      expect(out.whoKey).toEqual({
        status: 200,
        body: { user: `apikey:${out.keyId}`, session: null },
      });
      // A valid key on a route not in `apiKeyRoutes` is refused as a session-only route.
      expect(out.keyUndeclared).toBe(403);
    });

    it('checkPermission answers for the request principal only', () => {
      expect(out.permSession).toEqual({ status: 200, body: { read: true, del: false } });
      expect(out.permKey).toEqual({ status: 200, body: { read: true, del: false } });
      // A god asked about by id: inline would say yes; a worker may not ask.
      expect(out.asGod).toEqual({ status: 200, body: { other: false } });
    });

    it('CRUD through ctx.db: own table (session and key) and a tenant collection', () => {
      expect(out.notesSession).toEqual({ status: 201, body: { ok: true } });
      expect(out.notesKey).toEqual({ status: 201, body: { ok: true } });
      expect(out.notesRead).toEqual({
        status: 200,
        body: [
          { tag: 's', tags: ['a', 'b'] },
          { tag: 'k', tags: ['a', 'b'] },
        ],
      });
      expect(out.crud).toEqual({
        status: 200,
        body: { read: [{ title: 'crud' }], updated: 1, after: 'crud2', deleted: 1 },
      });
    });

    it('a request transaction: a rolled-back savepoint keeps the outer work, a throw keeps nothing', () => {
      expect(out.txnInner).toEqual({ status: 200, body: { ok: true } });
      expect(out['log:req-outer']).toBe(1);
      expect(out['log:req-inner']).toBe(0);
      expect(out.txnThrow).toBe(500);
      expect(out['log:req-thrown']).toBe(0);
    });

    it('db.transaction() outside a request (register, timer, event) commits or rolls back', () => {
      expect(out.emitTxn).toEqual({ status: 200, body: { ok: true } });
      for (const where of ['register', 'timer', 'event']) {
        expect(out[`log:${where}-keep`]).toBeGreaterThanOrEqual(1);
        expect(out[`log:${where}-drop`]).toBe(0);
      }
    });

    it("events: a listener outside its own and its dependencies' namespaces fails the load", () => {
      for (const [name, event] of [
        [stranger, `${dep}.tick`],
        [recorder, 'record.created'],
      ] as const) {
        expect(out[`enable:${name}`]).toMatchObject({ status: 422 });
        expect(JSON.stringify(out[`enable:${name}`])).toContain(`may not listen to \\"${event}\\"`);
      }
    });

    it("events: its own and its dependency's arrive; an engine event is refused", () => {
      expect(out.emitOwn).toEqual({ status: 200, body: { ping: { n: 7 } } });
      expect(out.depTick).toEqual({ status: 200, body: { ok: true } });
      expect(out.tick).toEqual({ status: 200, body: { tick: { from: dep } } });
      expect(out.emitEngine).toMatchObject({ status: 200, body: { emitted: false } });
      expect((out.emitEngine as { body: { error: string } }).body.error).toContain(
        'may not emit "record.created"',
      );
    });

    it('services: a declared dependency answers; a squatted name and an undeclared call do not', () => {
      expect(out.svcDep).toEqual({ status: 200, body: { out: { echoed: 'x' } } });
      expect(out.svcSquat).toEqual({
        status: 200,
        body: { error: `service "${dep}.squat" not found` },
      });
      expect(JSON.stringify(out.svcUndeclared)).toContain(
        `declare \\"${main}\\" in its manifest dependencies`,
      );
    });

    it('the caller credentials are stripped; a route gets back only what it opted into', () => {
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
      expect(out.fwd).toEqual({
        status: 200,
        body: {
          cookie: null,
          authorization: 'Bearer caller-token',
          'proxy-authorization': null,
          'x-api-key': null,
          'stripe-signature': 't=1,v1=abc',
        },
      });
    });

    it('a lapsed tenant member reads nothing and writes nothing (migration 060)', () => {
      expect(out.rowsInForce).toEqual({ status: 200, body: 2 });
      expect(out.addInForce).toEqual({ status: 200, body: { added: true } });
      expect(out.rowsLapsed).toEqual({ status: 200, body: 0 });
      expect(out.touchLapsed).toEqual({ status: 200, body: { updated: 0, deleted: 0 } });
      // Refused by the tenant write policy itself, not by some other failure.
      expect(out.addLapsed).toMatchObject({ status: 200, body: { added: false, errno: '42501' } });
      expect(out.lapsedCounts).toEqual({ added: 0, left: 2 });
    });
  });
}

describe.skipIf(skipAll)('third-party extension e2e — the runner legs ran', () => {
  it('CI has Docker for the runner legs', () => {
    if (process.env.CI) expect(hasDocker).toBe(true);
  });
});
