import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { loadDynamic } from '../../lib/extensions/lifecycle.js';
import { CannedDb } from './fixtures/canned-db.js';

/** A loaded `user` that found its optional `dep` below 2.0.0; `dep` then loads at `version`. */
async function upgrade(version: string): Promise<boolean | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'zv-optup-'));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ name: 'user', optionalDependencies: [{ name: 'dep', minVersion: '2.0.0' }] }),
  );
  const loader = new ExtensionLoader();
  loader.ctx = { db: new CannedDb().kysely } as never;
  const deps = new Map([['dep', false]]);
  loader.loaded.set('user', { version: '1.0.0', serviceDeps: deps } as never);
  loader.extDirs.set('user', dir);
  loader.loadExtension = async (name) => {
    loader.loaded.set(name, { version } as never);
  };
  await loadDynamic(loader, 'dep', {} as Hono);
  return deps.get('dep');
}

describe('an optional dependency upgraded while its dependent runs', () => {
  it('becomes callable once it meets the minVersion', async () => {
    expect(await upgrade('2.1.0')).toBe(true);
  });

  it('stays absent while still too old', async () => {
    expect(await upgrade('1.5.0')).toBe(false);
  });
});
