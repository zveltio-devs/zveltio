// Every worker is declared model only (RFC extension-model-v3 phase D slice 4,
// S2; ADR 0056 amendment 2026-11-21): the test override's unsigned worker
// included, the one mode in which a worker still differed from production.
//
// Before S2 that worker's `register()` got a real app and a `ctx` whose
// members were messages to the host (`worker-extension-ctx.ts`, the parity
// contract): routes of its own, `ctx.services`, `ctx.events`,
// `checkPermission`, `getSession`, each answered with the inline extension's
// own code. Driven here through the real loader and the real runtime over the
// `process` transport, unsigned:
//
//   - `register()` touching its app or any `ctx` member fails the load by name;
//   - a forged `host:call` for a ctx member is refused, and a frame outside the
//     protocol (`service:call`) is answered by nothing;
//   - its declared route serves, and a `host` call it leaves running past the
//     response (a timer) is refused: the request is over, so it has no caller.
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import {
  forgetInstalled,
  getTestApp,
  harnessAvailable,
  markInstalled,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const name = (n: string) => `wdm${n}${SFX}`;

/** What `register()` does, by case: each must fail the load, naming what it used. */
const REGISTERS = {
  app: `app.get('/own', (c) => c.text('own'))`,
  svc: `ctx.services.register('${name('svc')}.x', () => 1)`,
  evt: `ctx.events.on('${name('evt')}.ping', () => {})`,
  perm: `ctx.checkPermission`,
} as const;

// Written to the channel at import, past the runtime; the answers are read off
// the frames the runtime parses, and forwarded as log lines.
const forged = `import { writeSync } from 'node:fs';
const frame = (m) => { const b = new TextEncoder().encode(JSON.stringify(m)); const o = new Uint8Array(4 + b.length); new DataView(o.buffer).setUint32(0, b.length); o.set(b, 4); return o; };
const parse = JSON.parse;
JSON.parse = (t, r) => { const v = parse(t, r); if (v && String(v.id).startsWith('forged-')) console.warn('forged ' + v.id + ' ' + v.type + ' ' + (v.error ?? JSON.stringify(v.result ?? null))); return v; };
for (const m of [
  { type: 'host:call', id: 'forged-perm', op: 'checkPermission', args: ['u', 'admin', 'read'] },
  { type: 'service:call', id: 'forged-call', name: 'x.y', args: [] },
]) writeSync(1, frame(m));
`;

const served = (ext: string) => `${forged}
export default {
  name: '${ext}',
  routes: {
    hi: () => Response.json({ hi: true }),
    later: (request, { host }) => {
      setTimeout(() => {
        host.collections.read('${ext}_items', '1').then(
          () => console.warn('later ran'),
          (e) => console.warn('later ' + e.message),
        );
      }, 200);
      return Response.json({ answered: true });
    },
  },
  async register() {},
};
`;

function writeExt(base: string, ext: string, source: string, routes: unknown[] = []) {
  const dir = join(base, ext);
  mkdirSync(join(dir, 'engine'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name: ext,
      version: '1.0.0',
      routes,
      engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
    }),
  );
  writeFileSync(join(dir, 'engine', 'index.js'), source);
}

d('an unsigned worker is declared model only, as a signed one is', () => {
  let db: Database;
  let base = '';
  const app = new Hono();
  const loadErrors: Record<string, string | undefined> = {};
  const saved = process.env.ZVELTIO_EXT_TRANSPORT;
  const SERVED = name('ok');
  const all = [...Object.keys(REGISTERS).map(name), SERVED];
  const warn = spyOn(console, 'warn');

  beforeAll(async () => {
    _setInlineForTests(true); // unsigned fixtures: the test override stands in for a signature
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    ({ db } = await getTestApp());
    base = mkdtempSync(join(tmpdir(), 'wkr-declared-'));
    for (const [k, body] of Object.entries(REGISTERS)) {
      writeExt(
        base,
        name(k),
        `export default { name: '${name(k)}', async register(app, ctx) { ${body}; } };`,
      );
    }
    writeExt(base, SERVED, served(SERVED), [
      { method: 'GET', path: '/hi', access: 'caller', handler: 'hi' },
      { method: 'GET', path: '/later', access: 'caller', handler: 'later' },
    ]);
    _resetWorkerHostForTests();
    getWorkerHost(app);
    const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
    for (const ext of all) {
      await markInstalled(db, ext);
      await extensionLoader.loadExtension(ext, app, ctx, base);
      loadErrors[ext] = extensionLoader.getLastLoadError(ext);
    }
  }, 60_000);

  afterAll(async () => {
    warn.mockRestore();
    _setInlineForTests(false);
    if (saved === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved;
    await getWorkerHost(app).stopAll();
    _resetWorkerHostForTests();
    for (const ext of all) {
      extensionLoader.loaded.delete(ext);
      await forgetInstalled(db, ext);
    }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  const lines = (needle: string) =>
    warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(needle));

  for (const [k, used] of [
    ['app', 'app.get'],
    ['svc', 'ctx.services'],
    ['evt', 'ctx.events'],
    ['perm', 'ctx.checkPermission'],
  ] as const) {
    it(`register() using ${used} fails the load, by name`, () => {
      expect(loadErrors[name(k)]).toContain(`register() used ${used}: a worker-isolated`);
      expect(loadErrors[name(k)]).toContain('declared model only');
    });
  }

  it('serves its declared route', async () => {
    expect(loadErrors[SERVED]).toBeUndefined();
    const res = await app.request(`/ext/${SERVED}/hi`);
    expect([res.status, await res.json()]).toEqual([200, { hi: true }]);
  });

  it('refuses a forged ctx host call; a frame outside the protocol answers nothing', async () => {
    for (let i = 0; i < 40 && lines('] forged ').length < 1; i++) await Bun.sleep(50);
    await Bun.sleep(200);
    const replies = lines('] forged ');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(
      / forged-perm host:err host call "checkPermission" is refused: .*declared model only/,
    );
  });

  it('refuses a host call that outlives its request', async () => {
    const res = await app.request(`/ext/${SERVED}/later`);
    expect([res.status, await res.json()]).toEqual([200, { answered: true }]);
    for (let i = 0; i < 40 && lines('later').length < 1; i++) await Bun.sleep(50);
    expect(lines('later')).toHaveLength(1);
    expect(lines('later')[0]).toContain('is over (or was never issued)');
  });
});
