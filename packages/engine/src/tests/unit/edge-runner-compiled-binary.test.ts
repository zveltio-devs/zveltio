/**
 * A compiled binary is its own interpreter, and must be told so.
 *
 * `process.execPath` in a binary is `/usr/local/bin/zveltio`, not `bun`. The
 * runner spawns `<execPath> … <bootstrap.mjs>`, so with `run` it re-executes the
 * ENGINE with two arguments and the bootstrap never runs. Measured in a real
 * compiled binary before this was fixed: every edge function came back
 * `Killed by SIGKILL`, and since the in-process Worker mode was removed there
 * was nothing to fall back to — which means edge functions did not work in ANY
 * container deployment, because the image ships the binary.
 *
 * This asserts the choice. The compile-and-run gate
 * (`scripts/check-binary-edge-function.ts`) asserts the other half: that the
 * binary really is built from an entry point which answers the sentinel.
 */

import { describe, expect, it } from 'bun:test';
import {
  EDGE_RUNNER_SENTINEL,
  runnerInterpreterArgs,
  runningAsCompiledBinary,
} from '../../lib/edge-functions/runner-sentinel.js';

describe('choosing how to invoke the runner', () => {
  it('asks a compiled binary for the sentinel, not `run`', () => {
    expect(runnerInterpreterArgs(true)).toEqual([EDGE_RUNNER_SENTINEL]);
  });

  it('asks bun to `run` the bootstrap when not compiled', () => {
    expect(runnerInterpreterArgs(false)).toEqual(['run']);
  });

  it('knows this test process is not a compiled binary', () => {
    // If this ever reports true under `bun test`, the detection is matching
    // something it should not, and every spawn would use the sentinel against
    // an interpreter that has no idea what it means.
    expect(runningAsCompiledBinary()).toBe(false);
  });
});
