/**
 * Rollback reads the migrations the same way everything else does.
 *
 * `rollbackMigration` listed `migrations/sql/` unconditionally. In a compiled
 * binary that directory does not exist -- which is why `EMBEDDED_MIGRATIONS` is
 * generated at build time and why `runPending` and `listShippedMigrations` both
 * branch on it. `Bun.Glob.scanSync` throws ENOENT on a missing directory rather
 * than returning nothing, the outer catch turned that into a plain
 * `{ success: false }`, and `zveltio rollback` therefore failed on every
 * shipped artifact.
 *
 * This asserts the property that made the bug possible -- scanSync throws --
 * and that the three readers agree on where migrations come from.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'path';
import { EMBEDDED_MIGRATIONS } from '../../db/migrations/embedded.js';

describe('migration sources', () => {
  it('scanSync throws on a missing directory rather than returning nothing', () => {
    const glob = new Bun.Glob('*.sql');
    expect(() => [
      ...glob.scanSync({ cwd: '/nonexistent/zveltio/sql', onlyFiles: true }),
    ]).toThrow();
  });

  it('the embedded set is non-empty, so the binary has something to roll back', () => {
    expect(Object.keys(EMBEDDED_MIGRATIONS).length).toBeGreaterThan(0);
  });

  it('every function that reads the migration set has a binary-mode path', async () => {
    const src = await Bun.file(join(import.meta.dir, '../../db/migrations/index.ts')).text();

    // Split into top-level functions and check the ones that read the set.
    // The guard's SHAPE differs between them -- `runPending` uses an `if`, the
    // other two a ternary -- so what is asserted is the property they must
    // share: a reader that never mentions EMBEDDED_MIGRATIONS can only read
    // from disk, and on the shipped binary there is no disk to read.
    const bodies = src.split(/\n(?=(?:export )?(?:async )?function )/);
    const readers = bodies.filter(
      (b) => b.includes('listSqlFilesSync(') && !b.startsWith('function listSqlFilesSync'),
    );

    expect(readers.length).toBeGreaterThanOrEqual(3);
    for (const body of readers) {
      const name = /function (\w+)/.exec(body)?.[1] ?? '(anonymous)';
      expect(`${name}: ${body.includes('EMBEDDED_MIGRATIONS')}`).toBe(`${name}: true`);
    }
  });
});
