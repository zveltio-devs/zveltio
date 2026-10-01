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

import { afterAll, describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import {
  __limitedCmdForTests,
  __poolStatsForTests,
  cgroupLimitAvailable,
  drainRunnerPool,
  runEdgeFunctionInSubprocess,
} from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };
const available = cgroupLimitAvailable();

afterAll(async () => {
  await drainRunnerPool();
});

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

  // The pool holds runners spawned under the DEFAULT budget. The 3 GB case above
  // fails under either budget, so it cannot tell whether a tighter caller was
  // handed one of them; 400 MB fits the default and not 128 MB.
  it('does not serve a tighter budget from the default-budget pool', async () => {
    // Start from an empty pool so every runner waiting in it is a default one.
    await drainRunnerPool();
    const plain = 'async function handler() { return { status: 200, body: 1 }; }';
    await runEdgeFunctionInSubprocess(plain, REQ, {}, 10_000);
    await Bun.sleep(400);
    expect(__poolStatsForTests().idle).toBeGreaterThan(0);

    const code = `async function handler() {
      const held = [];
      for (let i = 0; i < 400; i++) held.push(new Uint8Array(1048576).fill(1));
      return { status: 200, body: held.length };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 20_000, { memoryLimitMb: 128 });

    expect(res.ok).toBe(false);
  }, 30_000);
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

  // Defence in depth behind lockdownGlobals(): if untrusted code ever reaches
  // process.env, the engine's secrets must not be in it. Read from the kernel,
  // since the sandbox itself cannot see process.env at all. A non-default budget
  // makes this a fresh spawn, after the variable below is set.
  it.skipIf(process.platform !== 'linux')(
    "does not hand the engine's environment to the child",
    async () => {
      const previous = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'postgres://edge-env-probe';
      try {
        const running = runEdgeFunctionInSubprocess(
          'async function handler() { await new Promise((r) => setTimeout(r, 1500)); return 1; }',
          REQ,
          {},
          10_000,
          { memoryLimitMb: 2048 },
        );
        await Bun.sleep(500);
        const pid = __poolStatsForTests().servedPids.at(-1);
        const environ = await Bun.file(`/proc/${pid}/environ`).text();
        expect((await running).ok).toBe(true);

        const names = environ.split('\0').map((kv) => kv.split('=')[0]);
        expect(names).toContain('PATH');
        expect(names).not.toContain('DATABASE_URL');
        expect(names).not.toContain('DBUS_SESSION_BUS_ADDRESS');
      } finally {
        if (previous === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previous;
      }
    },
    15_000,
  );
});
