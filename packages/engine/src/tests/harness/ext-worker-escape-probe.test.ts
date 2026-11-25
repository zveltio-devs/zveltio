/**
 * ADR 0062 proof, probe "security": code running as an extension worker tries
 * to escape, and each attempt is recorded as reached or refused. Pass = zero
 * escapes. The probe extension is signed (level 3, declared model only) and goes
 * through the engine's own loader, behind the engine's own `/ext/*` chain, over
 * the `process` transport.
 *
 * What this file proves, and what it does not:
 * - The engine's own decisions (host.collections, host.actions.run, enqueue,
 *   files, the frames it accepts, tenancy, SQL strings through every host path)
 *   are the same on every transport: the host answers them in the engine. They
 *   are proven here, and each refusal has a control that reaches.
 * - The operating system probes (env, files, sockets, spawn, FFI) are recorded
 *   over `process`, where the extension runs as the engine's child under the
 *   engine's uid — development only, refused in production — so files, sockets,
 *   spawn and FFI REACH by design; only the environment is closed there. That
 *   row is the control that shows the probes work. On the runner the same
 *   probes run in `scripts/ext-runner-isolation.ts`, over systemd, compose and
 *   one container (CI `ext-runner-systemd` and `ext-runner-isolation`).
 * - The same probes run as an INLINE first-party extension: the baseline that
 *   motivates ADR 0062 (environment, files, `ctx.db`).
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { schemaDigest } from '../../lib/extensions/declared-collections.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { toJsonb } from '../../lib/jsonb.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import {
  asEveryTenant,
  asTenant,
  createMemberSession,
  dropTestCollection,
  forgetInstalled,
  getTestApp,
  harnessAvailable,
  markInstalled,
} from '../../testing/app-harness.js';
import { signAsOperator } from '../../testing/operator-signed.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = String(Date.now()).slice(-7);
const EXT = `psec${STAMP}`; // the probe, as a worker
const INL = `psecin${STAMP}`; // the same probe, inline
const FOR = `psecfor${STAMP}`; // another extension, a worker
const OWN = `psec_own_${STAMP}`;
const OWNI = `psec_owni_${STAMP}`;
const FOREIGN = `psec_for_${STAMP}`;
const UNDECL = `psec_und_${STAMP}`;
const CANARY = `psec_canary_${STAMP}`;
const SECRET = `CANARY-SECRET-${STAMP}`;
const B_MARK = `TENANT-B-ROW-${STAMP}`;
const B = crypto.randomUUID();

/**
 * The probe bundle. `call` drives one host member with the arguments it is
 * given and reports reached/refused; `os` tries the operating system; `frame`
 * writes raw protocol frames on the channel; `db` reaches for `ctx.db`.
 */
const bundle = (name: string) => `
import { connect } from 'node:net';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
let ctxSeen = null;
const why = (e) => String(e?.code ?? e?.message ?? e);
const denied = (e) => 'DENIED ' + why(e);
const tryRead = (p) => { try { return 'READ ' + readFileSync(p).length + 'B'; } catch (e) { return denied(e); } };
const dial = (opts) => new Promise((resolve) => {
  let s;
  try { s = connect(opts); } catch (e) { resolve(denied(e)); return; }
  const done = (r) => { s.destroy(); resolve(r); };
  s.setTimeout(3000, () => done('DENIED timeout'));
  s.once('connect', () => done('CONNECTED'));
  s.once('error', (e) => done(denied(e)));
});
const frame = (msg) => {
  const body = new TextEncoder().encode(JSON.stringify(msg));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
};
async function hostMember(host, member, args) {
  const [group, fn] = member.split('.');
  const target = fn === undefined ? host[group] : host[group]?.[fn];
  try { return { reached: true, value: await target(...args) }; }
  catch (e) { return { refused: why(e), status: e?.status ?? null }; }
}
export default {
  name: '${name}',
  mountStrategy: 'subapp',
  routes: {
    probe: async (request, { host }) => {
      const q = JSON.parse(new URL(request.url).searchParams.get('q'));
      return Response.json(await hostMember(host, 'collections.' + q.member, q.args));
    },
  },
  actions: {
    call: async (input, host) => hostMember(host, input.member, input.args),
    callForeign: async (input, host) => hostMember(host, input.member, input.args),
    os: async (t) => {
      const env = {};
      for (const k of ['DATABASE_URL', 'TEST_DATABASE_URL', 'BETTER_AUTH_SECRET', 'FIELD_ENCRYPTION_KEY'])
        env[k] = process.env[k] ? 'READ' : 'absent';
      let bunSql;
      try {
        const pg = new Bun.SQL(t.pgUrl, { connectionTimeout: 3 });
        const r = await pg\`SELECT current_user AS u\`;
        await pg.close();
        bunSql = 'QUERIED as ' + r[0].u;
      } catch (e) { bunSql = denied(e); }
      let spawn;
      try {
        const r = Bun.spawnSync(['id', '-u'], { stdin: 'ignore', stderr: 'ignore' });
        spawn = r.success ? 'SPAWNED uid ' + r.stdout.toString().trim() : 'DENIED exit ' + r.exitCode;
      } catch (e) { spawn = denied(e); }
      let ffi;
      try {
        const { dlopen } = await import('bun:ffi');
        const lib = dlopen('libc.so.6', { getpid: { args: [], returns: 'i32' } });
        ffi = 'LOADED getpid=' + lib.symbols.getpid();
      } catch (e) { ffi = denied(e); }
      let fetched;
      try { fetched = 'HTTP ' + (await fetch(t.httpUrl, { signal: AbortSignal.timeout(3000) })).status; }
      catch (e) { fetched = denied(e); }
      let wrote;
      try { writeFileSync(t.writePath, 'x'); wrote = 'WROTE'; } catch (e) { wrote = denied(e); }
      return {
        env,
        envKeys: Object.keys(process.env).sort(),
        environ: tryRead('/proc/' + t.enginePid + '/environ'),
        engineEnvFile: tryRead(t.engineEnvFile),
        shadow: tryRead('/etc/shadow'),
        engineSource: tryRead(t.engineSource),
        otherExtension: tryRead(t.otherExtension),
        writeOtherExtension: wrote,
        tcpPostgres: await dial({ host: '127.0.0.1', port: t.pgPort }),
        tcpInternet: await dial({ host: '1.1.1.1', port: 443 }),
        unixPostgres: await dial(t.pgSocket),
        bunSql,
        spawn,
        ffi,
        fetch: fetched,
      };
    },
    // Raw frames on the channel, past the runtime's own send(). With \`steal\`
    // it first learns its own invocation's request id (a patched
    // AsyncLocalStorage, as hostile code would): the control that shows a
    // frame written this way is read by the host at all.
    frame: async (input, host) => {
      let requestId;
      if (input.steal) {
        const orig = AsyncLocalStorage.prototype.getStore;
        AsyncLocalStorage.prototype.getStore = function () {
          const s = orig.call(this);
          if (s && typeof s.id === 'string') requestId = s.id;
          return s;
        };
        try { await host.collections.list('${OWN}', { limit: 1 }); } finally {
          AsyncLocalStorage.prototype.getStore = orig;
        }
      }
      for (const f of input.frames) {
        writeSync(1, frame(input.steal ? { ...f, requestId } : f));
      }
      if (input.oversize) {
        const head = new Uint8Array(4);
        new DataView(head.buffer).setUint32(0, 0x7fffffff);
        writeSync(1, head);
      }
      await Bun.sleep(input.wait ?? 300);
      return { sent: input.frames.length, requestId: requestId ? 'stolen' : null };
    },
    db: async (input) => {
      const out = {};
      const tries = {
        users: (db) => db.selectFrom('user').select(['email']).limit(1).execute(),
        accounts: (db) => db.selectFrom('account').select(['password']).limit(1).execute(),
        apiKeys: (db) => db.selectFrom('zv_api_keys').select(['id']).limit(1).execute(),
        otherTenantRows: (db) => db.selectFrom(input.table).select(['label', 'tenant_id']).execute(),
      };
      for (const [k, run] of Object.entries(tries)) {
        try { const rows = await run(ctxSeen.db); out[k] = 'REACHED ' + JSON.stringify(rows).slice(0, 120); }
        catch (e) { out[k] = denied(e); }
      }
      return out;
    },
  },
  async register(_app, ctx) { ctxSeen = ctx; },
};
`;

const foreignBundle = `
export default {
  name: '${FOR}',
  actions: {
    echo: async (input) => ({ echoed: input }),
    secret: async () => ({ secret: '${SECRET}' }),
    put: async (input, host) => host.collections.insert('${FOREIGN}', { label: input.label }),
  },
  async register() {},
};
`;

/** The 32 SQL attack strings, sent through every host path a worker has. */
const ATTACKS = [
  "' OR '1'='1",
  "' OR 1=1 --",
  `1; DROP TABLE ${CANARY}; --`,
  `x'; DROP TABLE ${CANARY}; --`,
  `x"; DROP TABLE ${CANARY}; --`,
  `x) UNION SELECT secret FROM ${CANARY} --`,
  `' UNION SELECT secret, secret FROM ${CANARY} --`,
  `"; SELECT set_config('zveltio.current_tenant', '${B}', false); --`,
  `'; SELECT set_config('zveltio.current_tenant', '${B}', true) --`,
  "'; RESET ROLE; --",
  "'; SET ROLE postgres; --",
  "'; SET SESSION AUTHORIZATION postgres; --",
  "' AND pg_sleep(3) IS NOT NULL --",
  '1) OR pg_sleep(3) IS NULL --',
  `$$; DROP TABLE ${CANARY}; $$`,
  `$t$ DROP TABLE ${CANARY} $t$`,
  `label" FROM ${CANARY} --`,
  `public.${CANARY}`,
  `"public"."${CANARY}"`,
  'zv_api_keys',
  'ZV_API_KEYS',
  '../user',
  'user',
  'pg_catalog.pg_authid',
  'information_schema.tables',
  `'; COPY ${CANARY} TO PROGRAM 'id'; --`,
  "'; COPY (SELECT 1) TO '/tmp/psec-pwn'; --",
  `\\'; DROP TABLE ${CANARY}; --`,
  `x\u0000'; DROP TABLE ${CANARY}; --`,
  "label->>'x' OR 1=1",
  `(SELECT secret FROM ${CANARY})`,
  `id::text || (SELECT secret FROM ${CANARY})`,
];

type Probe = { reached?: boolean; value?: unknown; refused?: string; status?: number | null };

d('an extension worker cannot escape (ADR 0062 probe "security")', () => {
  let db: Database;
  let base: string;
  let app: Hono;
  let member: { cookie: string; userId: string };
  let ownRow = '';
  let bRow = '';
  const table: { probe: string; transport: string; result: string }[] = [];
  const saved = { transport: process.env.ZVELTIO_EXT_TRANSPORT, inline: false };

  const record = (probe: string, transport: string, result: string) => {
    table.push({ probe, transport, result });
  };
  const act = async (ext: string, name: string, body: unknown) => {
    const res = await app.request(`/ext/${ext}/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: member.cookie },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {}
    // An action's answer is `{ result }`; a refusal is a problem document.
    const result = (json as { result?: unknown } | null)?.result ?? json;
    return { status: res.status, json: result as Record<string, unknown> | null, text };
  };
  /** One host member through action `call`: reached only on a 200 carrying `reached`. */
  const probe = async (member_: string, args: unknown[], action = 'call', ext = EXT) => {
    const r = await act(ext, action, { member: member_, args });
    const p = (r.json ?? {}) as Probe;
    return { ...r, reached: r.status === 200 && p.reached === true, p };
  };
  const route = async (member_: string, args: unknown[]) => {
    const q = encodeURIComponent(JSON.stringify({ member: member_, args }));
    const res = await app.request(`/ext/${EXT}/probe?q=${q}`, { headers: { cookie: member.cookie } });
    const text = await res.text();
    let p: Probe = {};
    try {
      p = JSON.parse(text);
    } catch {}
    return { status: res.status, text, reached: res.status === 200 && p.reached === true, p };
  };
  const rows = async (collection: string, label: string) =>
    (
      await asEveryTenant(
        db,
        sql<{ id: string; tenant_id: string }>`
          SELECT id, tenant_id FROM ${sql.table(`zvd_${collection}`)} WHERE label = ${label}`,
      )
    ).rows;

  function writeExt(
    name: string,
    code: string,
    manifest: Record<string, unknown>,
    collections: string[],
    writtenBy?: 'actions',
  ): string {
    const dir = join(base, name);
    mkdirSync(join(dir, 'engine'), { recursive: true });
    mkdirSync(join(dir, 'schema', 'collections'), { recursive: true });
    const schema = new Map<string, Uint8Array>();
    for (const c of collections) {
      const json = JSON.stringify({
        name: c,
        ...(writtenBy ? { writtenBy } : {}),
        fields: [{ name: 'label', type: 'text' }],
      });
      writeFileSync(join(dir, 'schema', 'collections', `${c}.json`), json);
      schema.set(`collections/${c}.json`, new TextEncoder().encode(json));
    }
    writeFileSync(join(dir, 'engine', 'index.js'), code);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        permissions: ['data:write'],
        collections,
        ...(collections.length ? { integrity: { schemaSha256: schemaDigest(schema) } } : {}),
        ...manifest,
      }),
    );
    return dir;
  }

  async function load(name: string): Promise<void> {
    await markInstalled(db, name);
    // Consented at install, as an administrator does.
    await sql`UPDATE zv_extension_registry SET granted_capabilities = ${toJsonb(['data:write'])}
              WHERE name = ${name}`.execute(db);
    // The engine's own context, as boot hands it to the loader.
    const ctx =
      extensionLoader.ctx ??
      ({
        db,
        auth: getAuth(),
        events: engineEvents,
        fieldTypeRegistry: { register() {} },
        internals: buildExtensionInternals(),
      } as never);
    await extensionLoader.loadExtension(name, app, ctx, base);
    const err = extensionLoader.getLastLoadError(name);
    if (!extensionLoader.loaded.has(name)) throw new Error(`${name} did not load: ${err}`);
  }

  const declare = (name: string, resource: string, more: Record<string, unknown> = {}) => ({
    name,
    permission: { resource, action: 'execute' },
    input: { type: 'object' },
    // The gate's collection is one the action reads (manifest rule).
    reads: [resource],
    ...more,
  });

  beforeAll(async () => {
    let engine: Hono;
    ({ app: engine, db } = await getTestApp());
    base = mkdtempSync(join(tmpdir(), 'psec-'));
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    _resetWorkerHostForTests();
    getWorkerHost(app);

    // A collection nobody declared, which the caller may read and write.
    await DDLManager.createCollection(db, {
      name: UNDECL,
      fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    // The canary: a plain table, outside the data API, holding a secret.
    await sql`CREATE TABLE ${sql.table(CANARY)} (secret text)`.execute(db);
    await sql`INSERT INTO ${sql.table(CANARY)} VALUES (${SECRET})`.execute(db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${B}, ${`psec-b-${STAMP}`}, ${`psec b ${STAMP}`}, 'active')`.execute(db);

    const worker = { entry: 'engine/index.js', bundled: true, isolation: 'worker' };
    writeExt(
      FOR,
      foreignBundle,
      {
        engine: worker,
        actions: [
          declare('echo', FOREIGN),
          declare('secret', FOREIGN),
          declare('put', FOREIGN, { writes: [FOREIGN] }),
        ],
      },
      [FOREIGN],
      // Like a first-party collection: only its own extension's actions write it.
      'actions',
    );
    await signAsOperator(join(base, FOR), FOR);
    await load(FOR);

    const probeActions = (own: string) => [
      declare('call', own, {
        reads: [own],
        writes: [own],
        calls: [`${FOR}.echo`],
        enqueues: [],
      }),
      declare('callForeign', own, { reads: [own], writes: [FOREIGN] }),
      declare('os', own),
      declare('frame', own, { reads: [own], writes: [own] }),
      declare('db', own),
    ];
    writeExt(
      EXT,
      bundle(EXT),
      {
        engine: worker,
        dependencies: [{ name: FOR }],
        routes: [{ method: 'GET', path: '/probe', access: 'caller', handler: 'probe' }],
        actions: probeActions(OWN),
      },
      [OWN],
    );
    await signAsOperator(join(base, EXT), EXT);
    await load(EXT);

    // The same bundle inline: the test override stands in for the registry's
    // signature, which is what lets first-party code run in the engine.
    saved.inline = _setInlineForTests(true);
    writeExt(
      INL,
      bundle(INL).replaceAll(OWN, OWNI),
      {
        engine: { entry: 'engine/index.js', bundled: true },
        dependencies: [{ name: FOR }],
        routes: [{ method: 'GET', path: '/probe', access: 'caller', handler: 'probe' }],
        actions: probeActions(OWNI),
      },
      [OWNI],
    );
    await load(INL);
    invalidateActivationCache();

    const all = ['read', 'create', 'update', 'delete', 'execute'];
    member = await createMemberSession(engine, db, {
      grants: [OWN, OWNI, FOREIGN, UNDECL].map((collection) => ({ collection, actions: all })),
    });
    // A row of its own (tenant A, the default) and one of tenant B's.
    const mine = await probe('collections.insert', [OWN, { label: `mine-${STAMP}` }]);
    if (!mine.reached) throw new Error(`own insert: ${mine.status} ${mine.text}`);
    ownRow = String((mine.p.value as { id: string }).id);
    await asTenant(db, B, (trx) =>
      sql`INSERT INTO ${sql.table(`zvd_${OWN}`)} (label, tenant_id) VALUES (${B_MARK}, ${B})`.execute(
        trx,
      ),
    );
    bRow = (await rows(OWN, B_MARK))[0]!.id;
  }, 120_000);

  afterAll(async () => {
    console.log(`\n[psec] probe | transport | result\n${table.map((r) => `[psec] ${r.probe} | ${r.transport} | ${r.result}`).join('\n')}`);
    _setInlineForTests(saved.inline);
    if (saved.transport === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved.transport;
    await getWorkerHost(app).stopAll();
    _resetWorkerHostForTests();
    for (const name of [EXT, INL, FOR]) await extensionLoader.unload(name).catch(() => {});
    if (!db) return;
    await forgetInstalled(db, EXT, INL, FOR);
    for (const c of [OWN, OWNI, FOREIGN, UNDECL]) await dropTestCollection(db, c).catch(() => {});
    await sql`DROP TABLE IF EXISTS ${sql.table(CANARY)}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${B}`.execute(db).catch(() => {});
    if (base) rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('operating system: env closed over process; files, sockets, spawn, FFI reach by design (engine uid, dev only)', async () => {
    const engineEnvFile = join(base, 'engine.env');
    writeFileSync(engineEnvFile, 'SECRET=hunter2-env-file\n');
    const pg = new URL(process.env.TEST_DATABASE_URL as string);
    const input = {
      enginePid: process.pid,
      engineEnvFile,
      engineSource: join(import.meta.dir, '../../index.ts'),
      otherExtension: join(base, FOR, 'engine', 'index.js'),
      writePath: join(base, FOR, 'planted'),
      pgPort: Number(pg.port || 5432),
      pgSocket: process.env.PROBE_PG_SOCKET ?? '/run/postgresql/.s.PGSQL.5432',
      pgUrl: process.env.TEST_DATABASE_URL,
      httpUrl: 'http://127.0.0.1:9/',
    };
    const w = await act(EXT, 'os', input);
    const i = await act(INL, 'os', input);
    expect(w.status).toBe(200);
    expect(i.status).toBe(200);
    const wo = w.json as Record<string, unknown>;
    const io = i.json as Record<string, unknown>;
    for (const [k, v] of Object.entries(wo)) record(`os.${k}`, 'process', JSON.stringify(v));
    for (const [k, v] of Object.entries(io)) {
      // The engine's environment names stay out of the report: their count says it.
      const shown = k === 'envKeys' ? `${(v as string[]).length} variables` : JSON.stringify(v);
      record(`os.${k}`, 'inline', shown);
    }

    // The environment is the one thing the process transport closes.
    expect(wo.env).toEqual({
      DATABASE_URL: 'absent',
      TEST_DATABASE_URL: 'absent',
      BETTER_AUTH_SECRET: 'absent',
      FIELD_ENCRYPTION_KEY: 'absent',
    });
    expect(wo.envKeys).toEqual(['BUN_BE_BUN', 'NODE_ENV']);
    // fetch is refused by the runtime itself (ADR 0022), on every transport.
    expect(String(wo.fetch)).toContain('no network egress');
    // Control: inline, the same probe reads the engine's environment.
    expect((io.env as Record<string, string>).TEST_DATABASE_URL).toBe('READ');
    expect((io.envKeys as string[]).length).toBeGreaterThan(2);
    // The rest reach over `process` (engine uid): these rows are the control
    // that the runner rows refuse something real.
    expect(String(wo.environ)).toStartWith('READ');
    expect(String(wo.engineEnvFile)).toStartWith('READ');
    expect(String(wo.tcpPostgres)).toBe('CONNECTED');
    expect(String(wo.spawn)).toStartWith('SPAWNED');
  }, 60_000);

  it('host.collections: its own collection, and nothing else (actions and routes)', async () => {
    // Controls: its own collection, both paths.
    const ownList = await probe('collections.list', [OWN, { limit: 5 }]);
    record('collections.list own', 'process', ownList.reached ? 'REACHED (control)' : ownList.text);
    expect(ownList.reached).toBe(true);
    const ownRoute = await route('read', [OWN, ownRow]);
    record('route collections.read own', 'process', ownRoute.reached ? 'REACHED (control)' : ownRoute.text);
    expect(ownRoute.reached).toBe(true);

    const targets: [string, string][] = [
      ['undeclared collection', UNDECL],
      ["another extension's collection", FOREIGN],
      ['engine table by physical name', `zvd_${OWN}`],
      ['engine table zvd_collections', 'zvd_collections'],
      ['user', 'user'],
      ['session', 'session'],
      ['account', 'account'],
      ['zv_api_keys', 'zv_api_keys'],
      ['zv_tenants', 'zv_tenants'],
      ['path traversal', `../${OWN}`],
      ['schema-qualified', `public.zvd_${OWN}`],
    ];
    for (const [what, c] of targets) {
      for (const [m, args] of [
        ['collections.list', [c, {}]],
        ['collections.insert', [c, { label: `sneak-${STAMP}` }]],
      ] as const) {
        const r = await probe(m, args as unknown[]);
        record(`${m} ${what}`, 'process', r.reached ? `ESCAPE ${r.text}` : `refused ${r.status} ${r.p.refused ?? r.text}`.slice(0, 160));
        expect(r.reached).toBe(false);
      }
      const rr = await route('list', [c, {}]);
      record(`route collections.list ${what}`, 'process', rr.reached ? `ESCAPE ${rr.text}` : `refused ${rr.status} ${rr.p.refused ?? ''}`.slice(0, 160));
      expect(rr.reached).toBe(false);
    }
    expect(await rows(UNDECL, `sneak-${STAMP}`)).toEqual([]);
    expect(await rows(FOREIGN, `sneak-${STAMP}`)).toEqual([]);

    // Control: its own extension's action writes it.
    const put = await act(FOR, 'put', { label: `put-${STAMP}` });
    record('foreign collection written by its own extension', 'process', `${put.status} (control)`);
    expect(await rows(FOREIGN, `put-${STAMP}`)).toHaveLength(1);
    // Declared in `writes`, and still another extension's: refused.
    const fw = await probe('collections.insert', [FOREIGN, { label: `fw-${STAMP}` }], 'callForeign');
    record('collections.insert foreign, declared in writes', 'process', fw.reached ? `ESCAPE ${fw.text}` : `refused ${fw.status} ${fw.p.refused}`.slice(0, 160));
    expect(await rows(FOREIGN, `fw-${STAMP}`)).toEqual([]);
    expect(fw.reached).toBe(false);
  }, 120_000);

  it('tenancy: forged tenant ids and another tenant’s rows, read and written', async () => {
    const forged = await probe('collections.insert', [OWN, { label: `forged-${STAMP}`, tenant_id: B }]);
    const landed = await rows(OWN, `forged-${STAMP}`);
    record('insert with tenant_id = B', 'process', `${forged.reached ? 'accepted' : 'refused'}; rows in B: ${landed.filter((r) => r.tenant_id === B).length}`);
    expect(landed.filter((r) => r.tenant_id === B)).toEqual([]);

    const filt = await probe('collections.list', [OWN, { filter: { tenant_id: { eq: B } } }]);
    const filt2 = await probe('collections.list', [OWN, { filter: { label: { eq: B_MARK } } }]);
    const read = await probe('collections.read', [OWN, bRow]);
    const upd = await probe('collections.update', [OWN, bRow, { label: 'overwritten' }]);
    const del = await probe('collections.delete', [OWN, bRow]);
    const rRead = await route('read', [OWN, bRow]);
    for (const [what, r] of [
      ['list filter tenant_id = B', filt],
      ['list filter label = B row', filt2],
      ['read B row by id', read],
      ['update B row by id', upd],
      ['delete B row by id', del],
      ['route read B row by id', rRead],
    ] as const) {
      const leaked = r.text.includes(B_MARK);
      record(`tenancy ${what}`, 'process', leaked ? `ESCAPE ${r.text.slice(0, 120)}` : `no B data (${r.status} ${r.reached ? 'empty' : r.p.refused ?? ''})`.slice(0, 160));
      expect(leaked).toBe(false);
    }
    // A read of B's id answers like a missing row: nothing of it comes back.
    expect(read.p.value ?? null).toBeNull();
    expect(await rows(OWN, B_MARK)).toHaveLength(1);
    expect(await rows(OWN, 'overwritten')).toEqual([]);
  }, 60_000);

  it('host.actions.run, enqueue and files: only what is granted', async () => {
    const ok = await probe('actions.run', [FOR, 'echo', { x: 1 }]);
    record('actions.run granted (calls)', 'process', ok.reached ? 'REACHED (control)' : ok.text);
    expect(ok.reached).toBe(true);
    for (const [what, args] of [
      ['not in calls', [FOR, 'secret', {}]],
      ['own action, not in calls', [EXT, 'os', {}]],
      ['inline extension', [INL, 'db', {}]],
      ['unknown extension', ['engine', 'anything', {}]],
    ] as const) {
      const r = await probe('actions.run', args as unknown as unknown[]);
      record(`actions.run ${what}`, 'process', r.reached || r.text.includes(SECRET) ? `ESCAPE ${r.text}` : `refused ${r.status} ${r.p.refused}`.slice(0, 160));
      expect(r.reached).toBe(false);
      expect(r.text).not.toContain(SECRET);
    }
    const q = await probe('enqueue', ['undeclaredJob', {}]);
    record('enqueue undeclared job', 'process', q.reached ? `ESCAPE ${q.text}` : `refused ${q.p.refused}`.slice(0, 160));
    expect(q.reached).toBe(false);
    const f = await probe('files.read', [crypto.randomUUID()]);
    record('files.read unknown id', 'process', f.reached ? `ESCAPE ${f.text}` : `refused ${f.p.refused}`.slice(0, 160));
    expect(f.reached).toBe(false);
  }, 60_000);

  it('forged frames: ids never issued, ops outside the protocol, SQL frames, foreign replies', async () => {
    const errors: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    const mark = (n: number) => `frame-${n}-${STAMP}`;
    const ins = (n: number) => ['collections.insert', OWN, { label: mark(n) }];
    try {
      // Control: a frame with its OWN live request id is read and answered.
      const ctl = await act(EXT, 'frame', {
        steal: true,
        frames: [{ type: 'host:call', id: 'ctl', op: 'action', args: ins(0) }],
      });
      expect(ctl.status).toBe(200);
      expect((ctl.json as { requestId: string }).requestId).toBe('stolen');
      record('frame host:call with its own live request id', 'process', `${(await rows(OWN, mark(0))).length} row (control: frames are read)`);
      expect(await rows(OWN, mark(0))).toHaveLength(1);

      const forged = [
        { type: 'host:call', id: 'f1', op: 'action', args: ins(1), requestId: `inv-act-${crypto.randomUUID()}` },
        { type: 'host:call', id: 'f2', op: 'action', args: ins(2) },
        { type: 'host:call', id: 'f3', op: 'collections', args: ins(3), requestId: `route-${crypto.randomUUID()}` },
        { type: 'host:call', id: 'f4', op: 'db:query', args: [`INSERT INTO zvd_${OWN} (label) VALUES ('${mark(4)}')`] },
        { type: 'host:call', id: 'f5', op: 'services', args: ['db', 'query'] },
        { type: 'db:query', id: 'f6', sql: `INSERT INTO zvd_${OWN} (label) VALUES ('${mark(6)}')`, params: [] },
        { type: 'sql', id: 'f7', sql: `DROP TABLE ${CANARY}` },
        { type: 'action:ok', id: `inv-act-${crypto.randomUUID()}`, result: { forged: true } },
        { type: 'route:ok', id: `route-${crypto.randomUUID()}`, status: 200, headers: {}, body: [] },
        { type: 'init:ok', id: 'init-forged' },
        { type: 'pong', id: 'ping-forged' },
      ];
      const r = await act(EXT, 'frame', { frames: forged });
      expect(r.status).toBe(200);
      for (const n of [1, 2, 3, 4, 6]) {
        const got = await rows(OWN, mark(n));
        record(`frame ${forged.find((f) => JSON.stringify(f).includes(mark(n)))?.type} #${n}`, 'process', got.length ? 'ESCAPE row written' : 'no effect');
        expect(got).toEqual([]);
      }
      expect(errors.some((e) => /refused a "db:query" frame/.test(e))).toBe(true);
      record('frame type outside the protocol', 'process', 'refused, logged once by name and key');
      expect((await sql<{ t: string | null }>`SELECT to_regclass(${CANARY})::text AS t`.execute(db)).rows[0]!.t).toBe(CANARY);
      // Still serving after all of it.
      expect((await probe('collections.list', [OWN, { limit: 1 }])).reached).toBe(true);

      // An oversized frame ends the channel: the box crashes alone, respawns.
      const big = await act(EXT, 'frame', { frames: [], oversize: true, wait: 2000 });
      const other = await act(FOR, 'echo', { x: 1 });
      let back = false;
      for (let i = 0; i < 50 && !back; i++) {
        await Bun.sleep(200);
        back = (await probe('collections.list', [OWN, { limit: 1 }])).reached;
      }
      record('oversized frame (2 GiB header)', 'process', `its action answered ${big.status}; the other extension answered ${other.status}; it respawned: ${back}`);
      expect(big.status).toBe(503);
      expect(other.status).toBe(200);
      expect(back).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('the 32 SQL attack strings, through every host path a worker has', async () => {
    const paths: [string, (s: string) => Promise<{ reached: boolean; text: string; ms: number }>][] =
      [];
    const timed =
      (fn: (s: string) => Promise<{ reached: boolean; text: string }>) => async (s: string) => {
        const t0 = performance.now();
        const r = await fn(s);
        return { ...r, ms: performance.now() - t0 };
      };
    paths.push(['collection name', timed((s) => probe('collections.list', [s, {}]))]);
    paths.push(['record id', timed((s) => probe('collections.read', [OWN, s]))]);
    paths.push(['update id', timed((s) => probe('collections.update', [OWN, s, { label: 'x' }]))]);
    paths.push(['delete id', timed((s) => probe('collections.delete', [OWN, s]))]);
    paths.push(['filter field', timed((s) => probe('collections.list', [OWN, { filter: { [s]: { eq: 1 } } }]))]);
    paths.push(['filter operator', timed((s) => probe('collections.list', [OWN, { filter: { label: { [s]: 1 } } }]))]);
    paths.push(['filter value', timed((s) => probe('collections.list', [OWN, { filter: { label: { eq: s } } }]))]);
    paths.push(['filter as string', timed((s) => probe('collections.list', [OWN, { filter: s }]))]);
    paths.push(['sort', timed((s) => probe('collections.list', [OWN, { sort: s }]))]);
    paths.push(['search', timed((s) => probe('collections.list', [OWN, { search: s }]))]);
    paths.push(['expand', timed((s) => probe('collections.list', [OWN, { expand: s }]))]);
    paths.push(['cursor', timed((s) => probe('collections.list', [OWN, { cursor: s }]))]);
    paths.push(['insert field name', timed((s) => probe('collections.insert', [OWN, { [s]: 'x' }]))]);
    paths.push(['insert value', timed((s) => probe('collections.insert', [OWN, { label: s }]))]);
    paths.push(['actions.run extension', timed((s) => probe('actions.run', [s, 'echo', {}]))]);
    paths.push(['actions.run action', timed((s) => probe('actions.run', [FOR, s, {}]))]);
    paths.push(['enqueue job', timed((s) => probe('enqueue', [s, {}]))]);
    paths.push(['files.read id', timed((s) => probe('files.read', [s]))]);
    paths.push(['route collection name', timed((s) => route('list', [s, {}]))]);
    paths.push(['route record id', timed((s) => route('read', [OWN, s]))]);

    const escapes: string[] = [];
    let n = 0;
    for (const [where, run] of paths) {
      let reachedCount = 0;
      for (const s of ATTACKS) {
        const r = await run(s);
        n++;
        if (r.text.includes(SECRET) || r.text.includes(B_MARK)) escapes.push(`${where}: ${s} leaked`);
        if (r.ms > 2500) escapes.push(`${where}: ${s} took ${Math.round(r.ms)} ms (pg_sleep ran?)`);
        if (r.reached) reachedCount++;
      }
      record(`sql x32 via ${where}`, 'process', `${reachedCount} answered as data, 0 leaked`);
    }
    // The strings that went in as data are stored as written, nothing more.
    const stored = await rows(OWN, ATTACKS[2]!);
    expect(stored.length).toBeLessThanOrEqual(1);
    const canary = await sql<{ secret: string }>`SELECT secret FROM ${sql.table(CANARY)}`.execute(db);
    expect(canary.rows).toEqual([{ secret: SECRET }]);
    expect(await rows(OWN, B_MARK)).toHaveLength(1);
    const b = await asEveryTenant(db, sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(`zvd_${OWN}`)} WHERE tenant_id = ${B}`);
    expect(b.rows[0]!.n).toBe(1);
    record('sql attacks total', 'process', `${n} requests, ${escapes.length} escapes`);
    expect(escapes).toEqual([]);
    expect(n).toBe(32 * paths.length);
  }, 300_000);

  it('baseline: the same bundle inline reaches what the worker cannot (ctx.db)', async () => {
    const w = await act(EXT, 'db', { table: `zvd_${OWN}` });
    const i = await act(INL, 'db', { table: `zvd_${OWN}` });
    for (const [k, v] of Object.entries(w.json ?? {})) record(`ctx.db ${k}`, 'process', String(v).slice(0, 140));
    for (const [k, v] of Object.entries(i.json ?? {})) record(`ctx.db ${k}`, 'inline', String(v).slice(0, 140));
    // A worker's ctx refuses every member.
    for (const v of Object.values(w.json ?? {})) expect(String(v)).toContain('declared model only');
    expect(Object.keys(w.json ?? {})).toHaveLength(4);
    // Inline, ctx.db is a database handle: whatever it lets through is reach the
    // worker does not have. Recorded, not asserted, beyond it being a handle.
    expect(i.status).toBe(200);
  }, 60_000);
});
