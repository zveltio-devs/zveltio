/**
 * The worker sandbox must refuse the module loader too.
 *
 * There are three runners in this directory and all three compile user code.
 * Two of them called `findDynamicImport` on the transpiled output; this one —
 * `sandbox.ts` → `worker-runner.ts`, the runner behind flow `run_script` and
 * `ctx.internals.runScript` — did not, for as long as the check has existed.
 *
 * What that was worth, measured on this runner rather than argued:
 *
 *     await import('node:fs')       → failed, incidentally (frozen prototypes
 *                                     break that module's own initialisation)
 *     await import('bun:sqlite')    → LOADED
 *       new Database('/tmp/x', { create: true })   → wrote a file on the host
 *       db.loadExtension('…')                      → reached dlopen
 *     await import('node:os')       → LOADED (userInfo, homedir, hostname)
 *
 * So the escape was open, and the reason nobody had tripped over it is that the
 * one module everybody tries is the one that happens to fail. The author of a
 * flow needs permission to write a flow — not permission to write files as the
 * engine user and load native code into a process beside it.
 *
 * These tests fail without the `findDynamicImport` call in worker-runner.ts:
 * the first two return output instead of an error, and `escape.sqlite` appears
 * on disk.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runScript } from '../../lib/script-runner.js';

const PROOF = join(tmpdir(), 'zveltio-worker-escape-proof.sqlite');

describe('worker sandbox — the module loader is closed', () => {
  it('refuses a script that writes to the host filesystem through bun:sqlite', async () => {
    rmSync(PROOF, { force: true });
    const res = await runScript(
      `const S = await import('bun:sqlite');
       const db = new S.Database(${JSON.stringify(PROOF)}, { create: true });
       db.run("CREATE TABLE pwned (x TEXT)");
       return 'wrote';`,
      {},
      8000,
    );

    expect(res.output).toBeNull();
    expect(res.error).toContain('cannot import modules');
    // The refusal has to happen before the module loads, not after.
    expect(existsSync(PROOF)).toBe(false);
    rmSync(PROOF, { force: true });
  });

  it('refuses a script that reads host details through node:os', async () => {
    const res = await runScript(
      `const os = await import('node:os'); return os.userInfo().username;`,
      {},
      8000,
    );
    expect(res.error).toContain('cannot import modules');
  });

  it('still runs ordinary scripts, and ones that merely mention importing', async () => {
    expect((await runScript('return 40 + 2;', {}, 8000)).output).toBe(42);
    const worded = await runScript(`const msg = 'importing data'; return msg;`, {}, 8000);
    expect(worded.error).toBeUndefined();
    expect(worded.output).toBe('importing data');
  });
});
