/**
 * The runner does not leave a temp directory behind on every process start.
 *
 * `mkdtemp` is deliberate: a predictable path under /tmp is a symlink target an
 * attacker can pre-place, and this file is executed by the engine. But a fresh
 * directory per process start, with nothing removing the old ones, accumulates.
 * Measured on a development machine before the repair: 1413 directories, 14 MB,
 * the oldest dated the day the subprocess runner landed. On a server that is one
 * per restart, per CLI invocation, per test run — and /tmp is RAM on many hosts.
 *
 * Two halves, because neither covers the other: the process removes its own on
 * an orderly exit, and a starting process sweeps the ones a SIGKILL left behind.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'bun';

const ENGINE = join(import.meta.dir, '..', '..', '..');

describe('bootstrap temp directories', () => {
  it('removes its own directory when the process exits normally', async () => {
    const probe = join(tmpdir(), `zveltio-tempdir-probe-${Date.now()}.ts`);
    writeFileSync(
      probe,
      `import { __bootstrapPathForTests } from ${JSON.stringify(
        join(ENGINE, 'src/lib/edge-functions/subprocess-runner.ts'),
      )};
console.log(__bootstrapPathForTests);
`,
    );
    const p = spawn({ cmd: [process.execPath, 'run', probe], stdout: 'pipe', stderr: 'pipe' });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    rmSync(probe, { force: true });

    expect(out).toContain('zveltio-edge-');
    // The child has exited, so its directory must be gone with it.
    expect(existsSync(out)).toBe(false);
  }, 20_000);

  it('sweeps a stale directory a killed process left behind', async () => {
    // A day-old directory that looks exactly like one of ours.
    const stale = join(tmpdir(), `zveltio-edge-stale${process.pid}`);
    mkdirSync(stale, { mode: 0o700, recursive: true });
    writeFileSync(join(stale, 'runner.mjs'), '// left by a killed engine\n');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    // Importing the module in a fresh process runs the sweep.
    const probe = join(tmpdir(), `zveltio-sweep-probe-${Date.now()}.ts`);
    writeFileSync(
      probe,
      `await import(${JSON.stringify(join(ENGINE, 'src/lib/edge-functions/subprocess-runner.ts'))});\n`,
    );
    const p = spawn({ cmd: [process.execPath, 'run', probe], stdout: 'pipe', stderr: 'pipe' });
    await new Response(p.stdout).text();
    await p.exited;
    rmSync(probe, { force: true });

    expect(existsSync(stale)).toBe(false);
  }, 20_000);

  it('leaves a directory that is still in use alone', async () => {
    // Same shape, but touched now — another engine could be running from it.
    const fresh = join(tmpdir(), `zveltio-edge-fresh${process.pid}`);
    mkdirSync(fresh, { mode: 0o700, recursive: true });
    writeFileSync(join(fresh, 'runner.mjs'), '// a live engine is using this\n');

    const probe = join(tmpdir(), `zveltio-keep-probe-${Date.now()}.ts`);
    writeFileSync(
      probe,
      `await import(${JSON.stringify(join(ENGINE, 'src/lib/edge-functions/subprocess-runner.ts'))});\n`,
    );
    const p = spawn({ cmd: [process.execPath, 'run', probe], stdout: 'pipe', stderr: 'pipe' });
    await new Response(p.stdout).text();
    await p.exited;
    rmSync(probe, { force: true });

    expect(existsSync(fresh)).toBe(true);
    rmSync(fresh, { recursive: true, force: true });
  }, 20_000);

  it('does not create one per invocation', async () => {
    // Import FIRST: loading the module is what writes this process's one
    // directory, and counting before that would score it as a leak.
    const { runEdgeFunctionInSubprocess, drainRunnerPool } = await import(
      '../../lib/edge-functions/subprocess-runner.js'
    );
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith('zveltio-edge-')).length;
    for (let i = 0; i < 5; i++) {
      await runEdgeFunctionInSubprocess(
        'async function handler() { return { status: 200, body: 1 }; }',
        { method: 'GET', headers: {}, query: {}, body: null, path: '/' },
        {},
        8000,
      );
    }
    await drainRunnerPool();
    const after = readdirSync(tmpdir()).filter((d) => d.startsWith('zveltio-edge-')).length;

    // One for this process, written once at module load — not one per call.
    expect(after).toBe(before);
  }, 40_000);
});
