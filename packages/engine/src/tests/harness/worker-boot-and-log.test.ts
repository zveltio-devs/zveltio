// Two worker defects measured out of process in the experiment
// (docs/engine/rfc-extension-runner-experiment.md): an Error logged by the
// extension reached the engine log as `{}`, and boot spawned every worker twice
// (once into the throwaway app, once more on the real one). Driven through the
// real loader, over the process transport, on declared routes. (This suite was
// worker-sql-bridge-fidelity; its SQL cases went with the bridge, RFC
// extension-model-v3 phase D slice 4.)
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import {
  forgetInstalled,
  getTestApp,
  harnessAvailable,
  markInstalled,
} from '../../testing/app-harness.js';
import { signAsOperator } from '../../testing/operator-signed.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const TRANSPORTS = ['process'] as const;
const extName = (t: string) => `wkrsql${t[0]}${SFX}`;

const entry = (name: string) => `
const BOOT = crypto.randomUUID();
export default {
  name: '${name}',
  routes: {
    boot: () => new Response(BOOT),
    log: () => {
      console.error(Object.assign(new Error('kaput'), { code: 'E_KAPUT' }));
      return new Response('ok');
    },
  },
  async register() {},
};
`;

d('a worker survives boot and logs as the console prints', () => {
  let db: Database;
  let base = '';
  const out: Record<string, Record<string, unknown>> = {};
  const saved = process.env.ZVELTIO_EXT_TRANSPORT;
  const savedCtx = extensionLoader.ctx;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    base = mkdtempSync(join(tmpdir(), 'wkr-sql-'));
    for (const transport of TRANSPORTS) {
      const name = extName(transport);
      const dir = join(base, name);
      mkdirSync(join(dir, 'engine'), { recursive: true });
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          routes: ['boot', 'log'].map((h) => ({
            method: 'GET',
            path: `/${h}`,
            access: 'caller',
            handler: h,
          })),
          engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
        }),
      );
      writeFileSync(join(dir, 'engine', 'index.js'), entry(name));
      await signAsOperator(dir, name);

      process.env.ZVELTIO_EXT_TRANSPORT = transport;
      _resetWorkerHostForTests();
      // Boot as index.ts does it: load into a throwaway app, then re-register on
      // the app that serves.
      const tempApp = new Hono();
      const app = new Hono();
      getWorkerHost(tempApp);
      const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
      // `loadAll` sets it at boot; `reRegisterExtension` does nothing without it.
      extensionLoader.ctx = ctx;
      await markInstalled(db, name);
      await extensionLoader.loadExtension(name, tempApp, ctx, base);
      const errors = spyOn(console, 'error');
      // Inside the try: a failed load must still forget its registry row, which
      // otherwise blocks every later default grant (no manifest on record).
      try {
        expect(extensionLoader.getLastLoadError(name)).toBeUndefined();
        const bootBefore = await (await tempApp.request(`/ext/${name}/boot`)).text();
        await extensionLoader.reRegisterExtension(name, app);
        const boot = await app.request(`/ext/${name}/boot`);
        await app.request(`/ext/${name}/log`);
        out[transport] = {
          sameWorker: boot.status === 200 && (await boot.text()) === bootBefore,
          log: errors.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('kaput')) ?? '',
        };
      } finally {
        errors.mockRestore();
        await getWorkerHost(app).stopAll();
        await revokeExtensionDbRoles(db, name, true).catch(() => undefined);
        await forgetInstalled(db, name);
      }
    }
  }, 90_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved;
    extensionLoader.ctx = savedCtx;
    _resetWorkerHostForTests();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  for (const t of TRANSPORTS) {
    describe(t, () => {
      it('boot spawns the worker once: re-registering on the serving app keeps it', () => {
        expect(out[t]?.sameWorker).toBe(true);
      });

      it('logs an Error with its message, code and stack, not as {}', () => {
        const line = out[t]?.log as string;
        expect(line).toContain('kaput');
        expect(line).toContain('E_KAPUT');
        expect(line).toMatch(/\n\s+at /);
      });
    });
  }
});
