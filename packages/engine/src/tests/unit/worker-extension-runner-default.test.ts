/**
 * Third-party (worker-isolated) extensions run on the extension runner in
 * production, and on a local child of the engine elsewhere (RFC
 * extension-runner, step 9). There is no in-thread worker any more, and no
 * opt-in that loads one: production without a runner fails closed.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforceRunnerInProduction } from '../../lib/extensions/load-phases.js';
import { extensionTransport } from '../../lib/worker-extension-transport.js';
import { _resetWorkerHostForTests } from '../../lib/worker-extension-host.js';

const workerManifest = { engine: { isolation: 'worker', bundled: true } } as never;
const inlineManifest = { engine: { bundled: true } } as never;

const saved = {
  NODE_ENV: process.env.NODE_ENV,
  ZVELTIO_EXT_TRANSPORT: process.env.ZVELTIO_EXT_TRANSPORT,
  ZVELTIO_EXT_RUNNER_SOCKET: process.env.ZVELTIO_EXT_RUNNER_SOCKET,
};
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetWorkerHostForTests();
});

describe('extensionTransport', () => {
  it('is the runner in production and a local child elsewhere', () => {
    expect(extensionTransport({ NODE_ENV: 'production' })).toBe('runner');
    expect(extensionTransport({ NODE_ENV: 'development' })).toBe('process');
    expect(extensionTransport({ NODE_ENV: 'test' })).toBe('process');
    expect(extensionTransport({})).toBe('process');
  });

  it('takes ZVELTIO_EXT_TRANSPORT when it names a transport', () => {
    expect(extensionTransport({ NODE_ENV: 'test', ZVELTIO_EXT_TRANSPORT: 'runner' })).toBe(
      'runner',
    );
    expect(extensionTransport({ NODE_ENV: 'production', ZVELTIO_EXT_TRANSPORT: 'process' })).toBe(
      'process',
    );
  });

  it('has no in-thread worker: the old value falls back to the default', () => {
    expect(extensionTransport({ NODE_ENV: 'production', ZVELTIO_EXT_TRANSPORT: 'worker' })).toBe(
      'runner',
    );
    expect(extensionTransport({ NODE_ENV: 'test', ZVELTIO_EXT_TRANSPORT: 'worker' })).toBe(
      'process',
    );
  });
});

describe('enforceRunnerInProduction', () => {
  it('refuses the local-child transport in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    const r = enforceRunnerInProduction('acme/thing', workerManifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastLoadError).toContain('only on the extension runner');
  });

  it('lets production load it on the runner, which is the default', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ZVELTIO_EXT_TRANSPORT;
    expect(enforceRunnerInProduction('acme/thing', workerManifest).ok).toBe(true);
  });

  it('does not gate development or tests', () => {
    process.env.NODE_ENV = 'development';
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    expect(enforceRunnerInProduction('acme/thing', workerManifest).ok).toBe(true);
  });

  it('does not touch a first-party (inline) extension', () => {
    process.env.NODE_ENV = 'production';
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    expect(enforceRunnerInProduction('finance/invoicing', inlineManifest).ok).toBe(true);
    expect(enforceRunnerInProduction('finance/invoicing', null).ok).toBe(true);
  });
});

/** Load a bundled worker-isolated extension through the real loader. */
async function loadWorkerExtension(): Promise<{
  loaded: boolean;
  error: string;
  ms: number;
}> {
  const { Hono } = await import('hono');
  const { loadExtensionFromDir } = await import('../../lib/extensions/load.js');
  const { CannedDb } = await import('./fixtures/canned-db.js');

  const base = mkdtempSync(join(tmpdir(), 'zv-runner-'));
  mkdirSync(join(base, 'acme-thing', 'engine'), { recursive: true });
  writeFileSync(
    join(base, 'acme-thing', 'manifest.json'),
    JSON.stringify({
      name: 'acme-thing',
      version: '1.0.0',
      engine: { bundled: true, entry: 'engine/index.js', isolation: 'worker' },
    }),
  );
  writeFileSync(
    join(base, 'acme-thing', 'engine', 'index.js'),
    `export default { name: 'acme-thing', register(app) { app.get('/x', (c) => c.text('ok')); } };`,
  );

  const db = new CannedDb();
  const loader = {
    loaded: new Map(),
    manifestMeta: new Map(),
    modules: new Map(),
    lastLoadError: new Map<string, string>(),
    extDirs: new Map(),
    forgetExtensionMessages: () => {},
    ctx: { db: db.kysely, fieldTypeRegistry: { register: () => {} } },
  };
  const t0 = Date.now();
  await loadExtensionFromDir(loader as never, 'acme-thing', new Hono(), loader.ctx as never, base);
  return {
    loaded: loader.loaded.has('acme-thing'),
    error: loader.lastLoadError.get('acme-thing') ?? '',
    ms: Date.now() - t0,
  };
}

describe('loadExtensionFromDir in production', () => {
  it('refuses the local-child transport before anything is mounted', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    const r = await loadWorkerExtension();
    expect(r.loaded).toBe(false);
    expect(r.error).toContain('only on the extension runner');
  });

  it('fails closed, at once, when no runner is reachable', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ZVELTIO_EXT_TRANSPORT;
    process.env.ZVELTIO_EXT_RUNNER_SOCKET = join(tmpdir(), `zv-no-runner-${Date.now()}.sock`);
    const r = await loadWorkerExtension();
    expect(r.loaded).toBe(false);
    expect(r.error).toContain('extension runner unreachable');
    // Not the 15 s init timeout: the socket error ends the load.
    expect(r.ms).toBeLessThan(5_000);
  }, 20_000);
});
