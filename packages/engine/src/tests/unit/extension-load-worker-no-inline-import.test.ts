/**
 * loadExtensionFromDir — a worker-isolated extension must NOT be imported in the
 * engine process.
 *
 * enforcePublisherTier sends community (untrusted, third-party) extensions down
 * the worker path precisely because the worker is meant to be the boundary. The
 * loader used to `await import(...)` the entry module first regardless, so the
 * extension's TOP-LEVEL code ran once in the engine process with engine
 * privileges — before any worker existed. A hostile extension never had to reach
 * a route handler, and none of the worker's later restrictions applied to that
 * first execution.
 *
 * The fixtures below record a side effect at module scope. If that side effect
 * is observable after loading, the module was imported and the boundary is gone.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { loadExtensionFromDir } from '../../lib/extensions/load.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import * as workerExtensionHost from '../../lib/worker-extension-host.js';
import { CannedDb } from './fixtures/canned-db.js';

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-wni-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

// biome-ignore lint/suspicious/noExplicitAny: minimal loader stub
function fakeLoader(): any {
  const db = new CannedDb();
  return {
    loaded: new Map(),
    manifestMeta: new Map(),
    modules: new Map(),
    lastLoadError: new Map(),
    ctx: {
      db: db.kysely,
      fieldTypeRegistry: { register: () => {} },
    } as unknown as ExtensionContext,
  };
}

/** Manifest + entry that writes a marker file at module scope when imported. */
function workerFixture(marker: string, isolation: 'worker' | 'inline') {
  return tmpExt({
    'wk-ext/manifest.json': JSON.stringify({
      name: 'wk-ext',
      version: '1.0.0',
      engine: { bundled: true, entry: 'engine/index.js', isolation },
    }),
    'wk-ext/engine/index.js': `
      import { writeFileSync } from 'node:fs';
      // Top-level: runs the instant this module is imported.
      writeFileSync(${JSON.stringify(marker)}, 'imported');
      export default {
        name: 'wk-ext',
        async register() {},
      };
    `,
  });
}

afterEach(() => {
  delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
});

describe('loadExtensionFromDir — worker isolation does not import in-process', () => {
  it('never evaluates the entry module when isolation=worker', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const marker = join(mkdtempSync(join(tmpdir(), 'zv-mark-')), 'imported.txt');
    const base = workerFixture(marker, 'worker');

    const startMock = spyOn(workerExtensionHost, 'getWorkerHost').mockReturnValue({
      start: async () => {},
      stop: async () => {},
    } as never);

    try {
      const loader = fakeLoader();
      await loadExtensionFromDir(loader, 'wk-ext', new Hono(), loader.ctx, base);
      // The only assertion that matters: the module's top-level never ran.
      expect(existsSync(marker)).toBe(false);
    } finally {
      startMock.mockRestore();
    }
  });

  it('still evaluates it for an inline extension — the control case', async () => {
    // Proves the fixture would record the import if one happened, so the
    // assertion above is not passing for an unrelated reason.
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const marker = join(mkdtempSync(join(tmpdir(), 'zv-mark-')), 'imported.txt');
    const base = workerFixture(marker, 'inline');

    const loader = fakeLoader();
    await loadExtensionFromDir(loader, 'wk-ext', new Hono(), loader.ctx, base);

    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf-8')).toBe('imported');
  });

  it('still discovers migrations for a worker extension, from disk', async () => {
    // The engine has to run them, and it can no longer ask the module for the
    // list — so it reads the conventional engine/migrations/*.sql directory.
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const marker = join(mkdtempSync(join(tmpdir(), 'zv-mark-')), 'imported.txt');
    const base = tmpExt({
      'mig-ext/manifest.json': JSON.stringify({
        name: 'mig-ext',
        version: '1.0.0',
        engine: { bundled: true, entry: 'engine/index.js', isolation: 'worker' },
      }),
      'mig-ext/engine/index.js': `
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(marker)}, 'imported');
        export default { name: 'mig-ext', async register() {} };
      `,
      'mig-ext/engine/migrations/002_second.sql': 'SELECT 2;',
      'mig-ext/engine/migrations/001_first.sql': 'SELECT 1;',
      'mig-ext/engine/migrations/notes.md': 'not a migration',
    });

    const seen: string[][] = [];
    const migRunner = await import('../../lib/extensions/migration-runner.js');
    const runSpy = spyOn(migRunner, 'runExtensionMigrations').mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: stubbed runner
      async (ext: any) => {
        seen.push(ext.getMigrations?.() ?? []);
      },
    );
    const hostSpy = spyOn(workerExtensionHost, 'getWorkerHost').mockReturnValue({
      start: async () => {},
      stop: async () => {},
    } as never);

    try {
      const loader = fakeLoader();
      await loadExtensionFromDir(loader, 'mig-ext', new Hono(), loader.ctx, base);
      expect(existsSync(marker)).toBe(false);
      const paths = seen[0] ?? [];
      expect(paths.map((p) => p.split('/').pop())).toEqual(['001_first.sql', '002_second.sql']);
    } finally {
      runSpy.mockRestore();
      hostSpy.mockRestore();
    }
  });
});
