/**
 * ADR 0056 amendment 2026-11-18: an unsigned directory never runs — not inline
 * (U3) and not on the runner either. A worker-isolated, bundled extension loaded
 * on neither the registry's signature nor an operator's ran all the same,
 * reached by a raw `zv_extension_registry` row (enable refuses it) or by an
 * unsigned archive. Its faults then had no signer to name.
 *
 * Through the engine's own loader, activated the way the bypass did: a row
 * written straight into the registry table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const EXT = `nosig${String(Date.now()).slice(-7)}`;

d('an unsigned worker-isolated directory never runs (no unsigned mode)', () => {
  let db: Database;
  let base: string;
  let marker: string;
  let wasOverride = false;
  const app = new Hono();

  beforeAll(async () => {
    db = (await getTestApp()).db;
    base = mkdtempSync(join(tmpdir(), 'nosig-'));
    marker = join(base, 'ran');
    const dir = join(base, EXT);
    mkdirSync(join(dir, 'engine'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: EXT,
        version: '1.0.0',
        engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
      }),
    );
    writeFileSync(
      join(dir, 'engine', 'index.js'),
      `await Bun.write(${JSON.stringify(marker)}, 'x');\n` +
        `export default { name: ${JSON.stringify(EXT)}, async register(app) { app.get('/hi', (c) => c.text('hi')); } };\n`,
    );
    wasOverride = _setInlineForTests(false);
    _resetWorkerHostForTests();
    getWorkerHost(app);
  });

  afterAll(async () => {
    _setInlineForTests(wasOverride);
    await extensionLoader.unload(EXT).catch(() => {});
    await getWorkerHost(app).stopAll();
    _resetWorkerHostForTests();
    await forgetInstalled(db, EXT);
    rmSync(base, { recursive: true, force: true });
  });

  // RFC v3 phase D slice 4, S4: the test override no longer stands in for a
  // signature — it used to load this very directory. No mode in which a worker
  // differs from production.
  for (const override of [false, true]) {
    it(`refuses it at load with how to sign it; its code never runs (test override ${override ? 'on' : 'off'})`, async () => {
      _setInlineForTests(override);
      try {
        await markInstalled(db, EXT);
        const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
        await extensionLoader.loadExtension(EXT, app, ctx, base);
        expect(extensionLoader.loaded.has(EXT)).toBe(false);
        expect(getWorkerHost(app).isRunning(EXT)).toBe(false);
        expect(extensionLoader.getLastLoadError(EXT)).toMatch(
          /not signed.*OPERATOR_PUBLIC_KEYS_JSON/s,
        );
        expect((await app.request(`/ext/${EXT}/hi`)).status).not.toBe(200);
        // Its bundle was never imported: by the engine, or by a worker.
        await Bun.sleep(200);
        expect(existsSync(marker)).toBe(false);
      } finally {
        _setInlineForTests(false);
        await extensionLoader.unload(EXT).catch(() => {});
      }
    }, 60_000);
  }
});
