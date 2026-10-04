/**
 * A worker-isolated (third-party) extension loads in production only when the
 * operator has said so.
 *
 * The worker is a thread inside the engine process. It keeps an extension out
 * of the engine's JavaScript objects; it does not keep it from the process's
 * files or environment, so it is not a security boundary for untrusted code.
 * Until extensions run out of process, production refuses them unless the
 * operator opts in with ZVELTIO_ALLOW_WORKER_EXTENSIONS=1.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { enforceWorkerOptIn } from '../../lib/extensions/load-phases.js';

const workerManifest = { engine: { isolation: 'worker', bundled: true } } as never;
const inlineManifest = { engine: { bundled: true } } as never;

const saved = {
  NODE_ENV: process.env.NODE_ENV,
  ZVELTIO_ALLOW_WORKER_EXTENSIONS: process.env.ZVELTIO_ALLOW_WORKER_EXTENSIONS,
};
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('enforceWorkerOptIn', () => {
  it('refuses a worker extension in production without the opt-in', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ZVELTIO_ALLOW_WORKER_EXTENSIONS;
    const r = enforceWorkerOptIn('acme/thing', workerManifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastLoadError).toContain('ZVELTIO_ALLOW_WORKER_EXTENSIONS=1');
  });

  it('loads it in production when the operator opted in', () => {
    process.env.NODE_ENV = 'production';
    process.env.ZVELTIO_ALLOW_WORKER_EXTENSIONS = '1';
    expect(enforceWorkerOptIn('acme/thing', workerManifest).ok).toBe(true);
  });

  it('does not gate development or tests', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ZVELTIO_ALLOW_WORKER_EXTENSIONS;
    expect(enforceWorkerOptIn('acme/thing', workerManifest).ok).toBe(true);
  });

  it('does not touch an extension that does not run in a worker', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ZVELTIO_ALLOW_WORKER_EXTENSIONS;
    expect(enforceWorkerOptIn('finance/invoicing', inlineManifest).ok).toBe(true);
    expect(enforceWorkerOptIn('finance/invoicing', null).ok).toBe(true);
  });
});

describe('loadExtensionFromDir asks enforceWorkerOptIn', () => {
  it('refuses a worker extension in production before anything is mounted', async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Hono } = await import('hono');
    const { loadExtensionFromDir } = await import('../../lib/extensions/load.js');
    const { CannedDb } = await import('./fixtures/canned-db.js');

    const base = mkdtempSync(join(tmpdir(), 'zv-optin-'));
    mkdirSync(join(base, 'acme-thing', 'engine'), { recursive: true });
    writeFileSync(
      join(base, 'acme-thing', 'manifest.json'),
      JSON.stringify({
        name: 'acme-thing',
        version: '1.0.0',
        engine: { bundled: true, entry: 'engine/index.js', isolation: 'worker' },
      }),
    );
    writeFileSync(join(base, 'acme-thing', 'engine', 'index.js'), 'export default {};');

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

    process.env.NODE_ENV = 'production';
    delete process.env.ZVELTIO_ALLOW_WORKER_EXTENSIONS;
    await loadExtensionFromDir(
      loader as never,
      'acme-thing',
      new Hono(),
      loader.ctx as never,
      base,
    );

    expect(loader.loaded.has('acme-thing')).toBe(false);
    expect(loader.lastLoadError.get('acme-thing') ?? '').toContain(
      'ZVELTIO_ALLOW_WORKER_EXTENSIONS=1',
    );
  });
});
