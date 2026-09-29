/**
 * Every read path goes through `readScope` (lib/data/read-scope.ts).
 *
 * The four mechanisms it bundles — row policies, extension query alters,
 * entity access and column permissions — were called one by one by each read
 * path, and each new path forgot one (#723, #724). This pins where they may
 * still be called directly, and how often: a new direct call anywhere, even in
 * a file already listed, fails here and has to say why it is not a read.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', '..');
const CALL = /getRlsFilters\(|\.applyAll\(|\.isAllowed\(|getColumnAccess\(|\.restricts\(/g;

/** Direct calls allowed per file, and why. */
const ALLOWED: Record<string, number> = {
  // The gate itself.
  'lib/data/read-scope.ts': 5,
  // Writes: PUT/PATCH/DELETE before-row checks (`update`/`delete`) and the
  // writable-column checks. The GET handler goes through the gate.
  'lib/data/handlers/single.ts': 15,
  'lib/data/handlers/bulk.ts': 8,
  // Handed to extensions as `ctx.internals`, which make their own reads.
  'lib/extensions/internals.ts': 2,
  // Push: writes. Pull goes through the gate.
  'routes/sync.ts': 2,
  // `?expand=` with no request identity (internal callers): columns by role.
  'lib/data/shape.ts': 1,
};

describe('read gate', () => {
  it('the row/column mechanisms are called directly only where listed', async () => {
    const found: Record<string, number> = {};
    for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: SRC })) {
      // Where the mechanisms are defined, and the tests.
      if (file.startsWith('tests/') || file.startsWith('lib/tenancy/')) continue;
      if (file === 'lib/data/query-alter.ts') continue;
      const n = (await Bun.file(join(SRC, file)).text()).match(CALL)?.length ?? 0;
      if (n > 0) found[file] = n;
    }
    expect(found).toEqual(ALLOWED);
  });
});
