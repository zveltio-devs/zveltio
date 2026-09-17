/**
 * runScript — the error and log channels, and the engine surviving a bad script.
 *
 * This file used to assert a double-encoded envelope: the Worker returned a
 * `Response` whose BODY was JSON carrying `{ output, error, logs }`, so
 * script-runner parsed a result out of a result and had to decide which `error`
 * won. That shape is gone. The subprocess protocol already carries `ok`,
 * `error` and `logs` beside the response, so each lives in one place and there
 * is nothing to prefer over anything else.
 *
 * What replaces it is the case the old design could not survive at all.
 */

import { describe, expect, it } from 'bun:test';
import { runScript } from '../../lib/script-runner.js';

describe('runScript — a script cannot take the engine with it', () => {
  it('refuses a script that allocates without bound, and keeps serving', async () => {
    // Measured on the Worker runner this module used to use: `bun` exited 137 —
    // SIGKILL from the OOM killer, on the PARENT process, with no error
    // reported and nothing written to any log. Every tenant on the instance
    // went with it.
    //
    // `run_script` is instance-admin-only, so this was never an escalation
    // path. It is the ordinary one: a bad loop in a scheduled flow stops the
    // product.
    const res = await runScript(
      `const held = [];
       for (let i = 0; i < 3000; i++) held.push(new Uint8Array(1048576).fill(1));
       return held.length;`,
      {},
      20_000,
    );

    expect(res.output).toBeNull();
    expect(res.error).toMatch(/out of memory/i);
    // Not the wall-clock timeout: that would mean the ceiling did nothing and
    // the process merely took too long to eat the machine.
    expect(res.error).not.toMatch(/timed out/i);

    // The engine is what is really being asserted. If the cap had not held,
    // this process would not exist to run the next line.
    const after = await runScript('return 1 + 1;', {}, 5000);
    expect(after.output).toBe(2);
  }, 40_000);

  it('reports a script error without swallowing the logs written before it', async () => {
    const res = await runScript(
      `console.log('before the failure'); throw new Error('handler reported failure');`,
      {},
      8000,
    );

    expect(res.output).toBeNull();
    expect(res.error).toContain('handler reported failure');
    expect(res.logs).toContain('before the failure');
  });
});
