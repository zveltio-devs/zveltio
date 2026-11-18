import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bundleExtensionEngine } from './extension-bundle.js';

// DR-28: an extension outside the monorepo with the SDK linked from a
// checkout. The SDK's own `kysely` sits beside the SDK, not under the
// extension root; Bun resolves it from the importing file, and so must pack.
const root = mkdtempSync(join(tmpdir(), 'zv-bundle-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

describe('bundleExtensionEngine', () => {
  it('resolves a core dep beside a linked SDK, from the importing file', async () => {
    put(
      'checkout/sdk/package.json',
      '{"name":"linked-sdk","type":"module","exports":{".":"./index.js"}}',
    );
    put('checkout/sdk/index.js', "export { marker } from 'kysely';\n");
    put(
      'checkout/node_modules/kysely/package.json',
      '{"name":"kysely","type":"module","exports":{".":{"import":"./index.js","default":"./index.js"}}}',
    );
    put(
      'checkout/node_modules/kysely/index.js',
      "export const marker = 'kysely-beside-the-sdk';\n",
    );
    put('ext/engine/index.ts', "export { marker } from 'linked-sdk';\n");
    mkdirSync(join(root, 'ext/node_modules'), { recursive: true });
    symlinkSync(join(root, 'checkout/sdk'), join(root, 'ext/node_modules/linked-sdk'));

    const outfile = join(root, 'ext/engine/index.js');
    await bundleExtensionEngine({
      entry: join(root, 'ext/engine/index.ts'),
      outfile,
      external: [],
      resolveDir: join(root, 'ext'),
    });
    expect(readFileSync(outfile, 'utf8')).toContain('kysely-beside-the-sdk');
  });

  it("reports Bun's build log, not a bare 'Bundle failed'", async () => {
    put('broken/engine/index.ts', "export { x } from 'no-such-package-dr28';\n");
    const run = bundleExtensionEngine({
      entry: join(root, 'broken/engine/index.ts'),
      outfile: join(root, 'broken/engine/index.js'),
      external: [],
      resolveDir: join(root, 'broken'),
    });
    await expect(run).rejects.toThrow('no-such-package-dr28');
  });
});
