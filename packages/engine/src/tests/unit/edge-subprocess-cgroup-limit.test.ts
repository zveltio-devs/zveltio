/**
 * A memory budget you can actually state.
 *
 * `RLIMIT_AS` — what `ulimit -v` sets — bounds VIRTUAL ADDRESS SPACE, not
 * resident memory, and JSC reserves far more address space than it uses. So the
 * smallest workable setting is about 1 GiB: below that Bun does not start at
 * all, and the failure is a core dump rather than a refusal. Measured:
 *
 *   ulimit -v 128 MiB, running only `console.log(1)`
 *     -> exit 133, Trace/breakpoint trap (core dumped)
 *
 * A 1 GiB floor is not a budget for a flow script. cgroup v2's `memory.max`
 * bounds RESIDENT memory instead, so 128 MB is a setting that means what it
 * says, and only the invocation's own process group is killed. Measured:
 *
 *   MemoryMax=128M, external 3 GB allocation -> exit 137 in 107 ms
 *   MemoryMax=128M, heap allocation          -> exit 137 in 207 ms
 *   MemoryMax=512M, ordinary work            -> fine
 *
 * These tests skip where the mechanism does not exist — a container without
 * systemd, a non-Linux host — and say so. A skip here is the honest answer;
 * what must NOT happen is a budget below the RLIMIT_AS floor silently doing
 * nothing, which is what these assert against.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import {
  __limitedCmdForTests,
  cgroupLimitAvailable,
  runEdgeFunctionInSubprocess,
} from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };
const available = cgroupLimitAvailable();

describe.skipIf(!available)('runEdgeFunctionInSubprocess — cgroup memory budget', () => {
  it('enforces a budget smaller than the RLIMIT_AS floor', async () => {
    const code = `async function handler() {
      const held = [];
      for (let i = 0; i < 3000; i++) held.push(new Uint8Array(1048576).fill(1));
      return { status: 200, body: held.length };
    }`;

    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 20_000, { memoryLimitMb: 128 });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/memory|killed/i);
  }, 30_000);

  it('lets an ordinary function run inside that budget', async () => {
    const code = `async function handler(request, env) {
      const rows = Array.from({ length: 5000 }, (_, i) => ({ i }));
      return { status: 200, body: { count: rows.length, who: env.WHO } };
    }`;

    const res = await runEdgeFunctionInSubprocess(code, REQ, { WHO: 'cgroup' }, 15_000, {
      memoryLimitMb: 128,
    });

    expect(res.ok).toBe(true);
    expect(res.response?.body).toEqual({ count: 5000, who: 'cgroup' });
  }, 20_000);
});

describe('the spawned command, whichever mechanism is available', () => {
  it('keeps the sandbox environment minimal even when a scope is created', () => {
    const cmd = __limitedCmdForTests(128);
    const script = cmd[cmd.length - 1];

    if (available) {
      expect(cmd[0]).toBe('systemd-run');
      expect(cmd).toContain('MemoryMax=128M');
      // Without this the budget is memory PLUS swap, and a runaway only slows.
      expect(cmd).toContain('MemorySwapMax=0');
      // systemd-run needs the session bus and hands its environment to what it
      // runs, so the two variables that let it work must be gone before the
      // interpreter starts. Order matters: unset, then exec.
      expect(script.indexOf('unset DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR')).toBeLessThan(
        script.indexOf('exec'),
      );
    } else {
      expect(cmd[0]).toBe('/bin/sh');
      // No scope, so nothing was added to the environment and nothing needs
      // removing — but the floor must apply rather than a budget that silently
      // does nothing.
      expect(script).toContain('ulimit -v');
      expect(script).not.toContain('unset DBUS_SESSION_BUS_ADDRESS');
    }
  });

  it('applies the CPU ceiling regardless of the memory mechanism', () => {
    const script = __limitedCmdForTests(128).at(-1) as string;
    expect(script).toContain('ulimit -t');
  });
});
