/**
 * The sandbox blocks names. `import()` is not a name.
 *
 * Everything dangerous is kept out of an edge function by shadowing a global —
 * `Bun`, `process`, `require`, `eval`, `Function`. `import()` is syntax, so
 * there is no binding to redefine and no parameter to shadow, and an audit rode
 * that straight through: `await import('node:fs')` inside a running edge
 * function read `/etc/passwd`, read the engine's own source, and wrote a file
 * that appeared on the host.
 *
 * A text check is usually a weak control, because code can build what it is
 * forbidden to write. It holds here precisely because the other doors are shut:
 * assembling an `import` call at runtime needs `eval` or the `Function`
 * constructor, and both already throw. So the literal has to be in the source.
 *
 * The false-positive case is the one worth keeping honest. The check runs on
 * transpiled output, where comments are gone, so a function that merely
 * mentions the word in prose still deploys.
 */

import { describe, expect, it } from 'bun:test';
import { findDynamicImport } from '../../lib/edge-functions/no-dynamic-import.js';

describe('edge functions cannot reach the module loader', () => {
  it('refuses the escape, in the shapes it is actually written', () => {
    for (const code of [
      `const fs = await import('node:fs');`,
      `const fs = await import("node:fs");`,
      `await import(\`node:\${'fs'}\`);`,
      `import ( 'node:child_process' )`,
      `return import('node:os').then(o => o.hostname());`,
    ]) {
      expect(findDynamicImport(code), code).not.toBeNull();
    }
  });

  it('lets ordinary code through', () => {
    for (const code of [
      `async function handler(request) { return { status: 200, body: 1 + 1, headers: {} }; }`,
      // `important(` and `reimport(` must not trip the word boundary.
      `const important = (x) => x; important(1);`,
      `function reimport(x) { return x; } reimport(2);`,
      // A string that talks about it, which a linter message or an error path
      // might legitimately contain.
      `const msg = "use import() elsewhere";`.replace('import()', 'importing'),
    ]) {
      expect(findDynamicImport(code), code).toBeNull();
    }
  });

  it('says what to do instead, because a refusal without a path is a dead end', () => {
    const msg = findDynamicImport(`await import('node:fs')`);
    expect(msg).toContain('fetch');
  });
});
