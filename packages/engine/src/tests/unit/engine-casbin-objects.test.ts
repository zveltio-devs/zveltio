/**
 * `ENGINE_CASBIN_OBJECTS` is the set of literal objects the engine's
 * `checkPermission` calls name — derived from the source, not remembered.
 *
 * A collection may not take one of those names (`DDLManager.reservedName`), and
 * a drop keeps their rules. An object added to a call here but not to the set
 * would be one a collection could be created under again, and drop again.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { ENGINE_CASBIN_OBJECTS } from '../../lib/tenancy/permissions.js';

const SRC = join(import.meta.dir, '../..');
const CALL = /checkPermission\(\s*[^,()]+,\s*(['"`])([^'"`$]+)\1/g;

describe('ENGINE_CASBIN_OBJECTS', () => {
  it('names exactly the literal objects the engine checks', async () => {
    const named = new Set<string>();
    for await (const file of new Bun.Glob('**/*.ts').scan(SRC)) {
      if (file.startsWith('tests/') || file.includes('.test.')) continue;
      const code = (await Bun.file(join(SRC, file)).text())
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      for (const m of code.matchAll(CALL)) named.add(m[2]!);
    }
    expect([...named].sort()).toEqual([...ENGINE_CASBIN_OBJECTS].sort());
  });
});
