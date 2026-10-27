import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { refreshOptionalDependents } from '../../lib/extensions/lifecycle.js';
import { CannedDb } from './fixtures/canned-db.js';

/** A loaded `user` that found its optional `dep` absent; `dep` then loads at `version`. */
async function upgrade(version: string, minVersion?: string): Promise<boolean | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'zv-optup-'));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ name: 'user', optionalDependencies: [{ name: 'dep', minVersion }] }),
  );
  const loader = new ExtensionLoader();
  const deps = new Map([['dep', false]]);
  loader.loaded.set('user', { version: '1.0.0', serviceDeps: deps } as never);
  loader.extDirs.set('user', dir);
  loader.loaded.set('dep', { version } as never);
  await refreshOptionalDependents(loader, 'dep', new CannedDb().kysely as never);
  return deps.get('dep');
}

describe('an optional dependency upgraded while its dependent runs', () => {
  it('becomes callable once it meets the minVersion', async () => {
    expect(await upgrade('2.1.0', '2.0.0')).toBe(true);
  });

  it('stays absent while still too old', async () => {
    expect(await upgrade('1.5.0', '2.0.0')).toBe(false);
  });

  it('an unpinned one becomes callable once it loads', async () => {
    expect(await upgrade('0.1.0')).toBe(true);
  });
});
