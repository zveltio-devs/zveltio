/**
 * ADR 0062 proof, probe "performance": `finance/invoicing` `createInvoice` as a
 * member through the engine's own `/ext/*` chain, in ONE mode per process:
 *
 *   inline   - the extension imported into the engine (`_setInlineForTests`)
 *   process  - signed worker, `ZVELTIO_EXT_TRANSPORT=process` (a child of the engine)
 *   runner   - signed worker on the systemd runner (`ZVELTIO_EXT_TRANSPORT=runner`)
 *
 * One mode per process because Hono cannot unmount inline routes: a second mode
 * in the same process silently measures inline twice.
 *
 *   TEST_DATABASE_URL=... bun ext-perf.ts <inline|process|runner> [--out f.json] [--cold 20]
 *
 * `DB_POOL_MAX` comes from the environment ('' = the engine default). Method and
 * how to run it on a VM: README.md next to this file.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { extensionLoader } from '../../src/lib/extensions/extension-loader.js';
import { _setInlineForTests } from '../../src/lib/extensions/load-phases.js';
import { buildExtensionInternals } from '../../src/lib/extensions/internals.js';
import { invalidateActivationCache } from '../../src/lib/extensions/activation.js';
import { activePoolMax } from '../../src/db/index.js';
import { getAuth } from '../../src/lib/auth.js';
import { runnerSocketPath, runnerUnit } from '../../src/lib/ext-runner.js';
import {
  _resetWorkerHostForTests,
  boxConcurrencyLimit,
  getWorkerHost,
} from '../../src/lib/worker-extension-host.js';
import { invalidateAllPermissionCaches } from '../../src/lib/tenancy/permissions.js';
import { sessionPrefetch } from '../../src/middleware/session-prefetch.js';
import { tenantMiddleware } from '../../src/middleware/tenant.js';
import { extensionAuthGate } from '../../src/middleware/extension-auth-gate.js';
import {
  asDefaultTenant,
  createMemberSession,
  forgetInstalled,
  getTestApp,
  markInstalled,
} from '../../src/testing/app-harness.js';
import { signAsOperator } from '../../src/testing/operator-signed.js';

const EXT = 'finance/invoicing';
const SIBLING =
  process.env.EXTENSIONS_SIBLING ?? join(import.meta.dir, '../../../../../zveltio-extensions');
const mode = process.argv[2] as 'inline' | 'process' | 'runner';
if (!['inline', 'process', 'runner'].includes(mode))
  throw new Error('usage: ext-perf.ts <inline|process|runner>');
const arg = (n: string, d: string) => process.argv[process.argv.indexOf(n) + 1] ?? d;
const OUT = arg('--out', '');
const COLD = Number(arg('--cold', '20'));
const WARM = 30;
const SEQ_N = 300;
const CONC = 10;
const CONC_N = 500;

process.env.ZVELTIO_EXT_TRANSPORT = mode === 'runner' ? 'runner' : 'process';
// '' is the engine's own default (40); the harness would otherwise force 10.
if (process.env.DB_POOL_MAX === undefined) process.env.DB_POOL_MAX = '';

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const stats = (xs: number[]) => ({
  n: xs.length,
  p50: +pct(xs, 50).toFixed(2),
  p95: +pct(xs, 95).toFixed(2),
  max: +Math.max(...xs).toFixed(2),
});

// ── memory: read here; a runner's processes run under another uid, so the driver
// (ext-perf.sh, run by the operator, with sudo) samples them when told to ──────
function smaps(pid: number) {
  try {
    const t = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t)?.[1] ?? 0);
    return {
      pid,
      rss_kb: kb('Rss'),
      pss_kb: kb('Pss'),
      cmd: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').slice(0, 80),
    };
  } catch {
    return null;
  }
}
async function memory(label: string) {
  if (mode === 'runner') {
    // The driver reads this line and writes <run>.mem; no file crosses the uids.
    console.log(`@@CHECKPOINT ${label}`);
    await Bun.sleep(4000);
    return 'sampled by ext-perf.sh into <run>.mem';
  }
  if (mode === 'inline') return [smaps(process.pid)];
  const kids = Bun.spawnSync(['pgrep', '-P', String(process.pid)])
    .stdout.toString()
    .split('\n')
    .filter(Boolean)
    .map(Number);
  return kids.map(smaps);
}

// ── set-up: the engine, the extension, a member with grants ──────────────────
const { app: engine, db } = await getTestApp();
const app = new Hono();
app.use('/ext/*', sessionPrefetch(getAuth(), db));
app.use('/ext/*', tenantMiddleware);
app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
_resetWorkerHostForTests();
const host = getWorkerHost(app);
let startArgs: Parameters<typeof host.start> | null = null;
const origStart = host.start.bind(host);
host.start = (...a) => ((startArgs = a), origStart(...a));

const base = mkdtempSync(join(tmpdir(), 'ext-perf-'));
const dir = join(base, EXT);
const manifest = JSON.parse(readFileSync(join(SIBLING, EXT, 'manifest.json'), 'utf8'));
cpSync(join(SIBLING, EXT), dir, {
  recursive: true,
  filter: (s) => !s.split('/').some((x) => x === 'node_modules' || x === '.zveltio-registry'),
});
if (mode !== 'inline') {
  manifest.engine.isolation = 'worker';
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await signAsOperator(dir, EXT);
}
_setInlineForTests(mode === 'inline');
await markInstalled(db, EXT);
const ctx =
  extensionLoader.ctx ??
  ({
    db,
    auth: getAuth(),
    internals: buildExtensionInternals(),
    fieldTypeRegistry: { register() {} },
  } as never);
await extensionLoader.loadExtension(EXT, app, ctx, base);
if (!extensionLoader.loaded.has(EXT))
  throw new Error(`not loaded: ${extensionLoader.getLastLoadError(EXT)}`);
invalidateActivationCache();

// The mode must be what was asked: inline routes cannot be unmounted, so a
// worker that is absent (or present under inline) means the run is not what it says.
if (host.isRunning(EXT) !== (mode !== 'inline'))
  throw new Error(`mode ${mode}: worker running = ${host.isRunning(EXT)}`);
if (mode === 'runner') {
  const a = Bun.spawnSync(['systemctl', 'is-active', runnerUnit(EXT)])
    .stdout.toString()
    .trim();
  if (a !== 'active') throw new Error(`runner unit is ${a}`);
}

for (let i = 0; i < 300; i++) {
  const t = await asDefaultTenant(
    db,
    sql<{
      n: string;
    }>`SELECT count(*)::text n FROM pg_class WHERE relname IN ('zvd_invoices','zvd_invoice_lines','zvd_document_series','zvd_company_profile')`,
  );
  if (t.rows[0]?.n === '4') break;
  await Bun.sleep(100);
}
await asDefaultTenant(
  db,
  sql`INSERT INTO zvd_document_series (doc_type, series, is_default, next_number, padding)
      SELECT 'invoice', 'BENCH', true, 1, 4
      WHERE NOT EXISTS (SELECT 1 FROM zvd_document_series WHERE doc_type = 'invoice')`,
);
const data = (collection: string, actions: string[]) => ({ collection, actions });
const member = await createMemberSession(engine, db, {
  grants: [
    data('invoices', ['read', 'create', 'update', 'execute']),
    data('invoice_lines', ['read', 'create']),
    data('document_series', ['read']),
    data('company_profile', ['read']),
  ],
});
await invalidateAllPermissionCaches();

const body = (lines: number) =>
  JSON.stringify({
    client_name: 'Bench Client SRL',
    lines: Array.from({ length: lines }, (_, i) => ({
      description: `line ${i}`,
      quantity: 2,
      unit_price: 10 + i,
      tax_rate: 19,
    })),
  });
const bodies = { 3: body(3), 20: body(20) } as Record<number, string>;
const call = (lines: number) =>
  app.request(`/ext/${EXT}/actions/createInvoice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: member.cookie },
    body: bodies[lines],
  });

type Outcome = { ms: number; status: number; busy: boolean };
async function one(lines: number): Promise<Outcome> {
  const t = performance.now();
  const res = await call(lines);
  const text = await res.text();
  return { ms: performance.now() - t, status: res.status, busy: text.includes('extension.busy') };
}
const summarise = (os: Outcome[], wallMs: number) => ({
  ...stats(os.filter((o) => o.status === 200).map((o) => o.ms)),
  ok: os.filter((o) => o.status === 200).length,
  busy: os.filter((o) => o.busy).length,
  otherErrors: os.filter((o) => o.status !== 200 && !o.busy).length,
  firstError: os.find((o) => o.status !== 200 && !o.busy)?.status ?? null,
  perSec: +((os.filter((o) => o.status === 200).length / wallMs) * 1000).toFixed(1),
});

const result: Record<string, unknown> = {
  mode,
  poolMax: process.env.DB_POOL_MAX || '(engine default: autosized)',
  poolInUse: activePoolMax(),
  boxLimit: mode === 'inline' ? null : boxConcurrencyLimit(activePoolMax()),
  bun: Bun.version,
  lines: {},
};

const memIdle = await memory('idle');
for (const lines of [3, 20]) {
  for (let i = 0; i < WARM; i++) await one(lines);
  const seq: Outcome[] = [];
  const t0 = performance.now();
  for (let i = 0; i < SEQ_N; i++) seq.push(await one(lines));
  const seqWall = performance.now() - t0;
  const conc: Outcome[] = [];
  let issued = 0;
  const t1 = performance.now();
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (issued < CONC_N) {
        issued++;
        conc.push(await one(lines));
      }
    }),
  );
  const concWall = performance.now() - t1;
  (result.lines as Record<number, unknown>)[lines] = {
    seq: summarise(seq, seqWall),
    conc: summarise(conc, concWall),
  };
}
result.memory = { idle: memIdle, afterRun: await memory('after') };

// ── cold start: unit stop, then start -> first action served ─────────────────
if (mode !== 'inline' && COLD > 0 && startArgs) {
  const [name, d, entry, source] = startArgs;
  const ready: number[] = [];
  const first: number[] = [];
  for (let i = 0; i < COLD; i++) {
    await host.stop(EXT);
    // The served app's matcher is built: the proxy routes of the restart go to a spare app
    // (actions are mounted on the served app once and reach the worker through the host).
    host.rebindApp(new Hono());
    await Bun.sleep(300);
    const t = performance.now();
    await host.start(name, d, entry, source);
    const t1 = performance.now();
    const o = await one(3);
    if (o.status !== 200) throw new Error(`first action after start: ${o.status}`);
    ready.push(t1 - t);
    first.push(performance.now() - t);
  }
  result.cold = {
    startToRegistered: stats(ready),
    startToFirstAction: stats(first),
    samplesMs: first.map((x) => +x.toFixed(1)),
  };
}

// ── runner floor: `systemctl start` and the socket, with no engine around it ──
if (mode === 'runner' && COLD > 0) {
  const unit = runnerUnit(EXT);
  const sock = runnerSocketPath(EXT);
  await host.stop(EXT);
  const cmdMs: number[] = [];
  const sockMs: number[] = [];
  for (let i = 0; i < COLD; i++) {
    Bun.spawnSync(['systemctl', 'stop', '--no-ask-password', unit]);
    await Bun.sleep(300);
    const t = performance.now();
    Bun.spawnSync(['systemctl', 'start', '--no-ask-password', unit]);
    cmdMs.push(performance.now() - t);
    while (!existsSync(sock)) await Bun.sleep(1);
    sockMs.push(performance.now() - t);
  }
  result.coldUnit = { systemctlStart: stats(cmdMs), startToSocket: stats(sockMs) };
  Bun.spawnSync(['systemctl', 'stop', '--no-ask-password', unit]);
}
result.health = host.getHealth();

// ── clean up ─────────────────────────────────────────────────────────────────
await host.stopAll();
await extensionLoader.unload(EXT).catch(() => {});
await forgetInstalled(db, EXT);
rmSync(base, { recursive: true, force: true });
const json = JSON.stringify(result, null, 1);
if (OUT) writeFileSync(OUT, json);
else console.log(json);
process.exit(0);
