/**
 * `coverage-gate` against a report that did not run the code it grades.
 *
 * On 2026-09-04 the gate printed this, on a branch where nothing had touched a
 * route handler:
 *
 *     lib:    96.4% → 90.6%   (dropped 5.8pt)
 *     routes: 73.6% → 13%     (dropped 60.6pt)
 *
 * Neither line is a measurement. `packages/engine/coverage/lcov.info` — the
 * script's own default input — was a leftover unit-only run listing 8 of the 37
 * files under `src/routes`, and lcov lists only the files a run LOADED. The
 * gate did arithmetic over it and reported the result with the confidence a real
 * regression would get.
 *
 * The alarming direction is the lucky one, and that is the point of this file. A
 * partial report whose loaded files happen to be the well-covered ones produces
 * a falsely REASSURING number, passes, and nobody looks at a gate that says OK.
 * Freshening the lcov fixes the day and leaves the hole.
 *
 * Three more defects came out of the same reading, and each has a case here:
 *
 *   - `floor` is described in the baseline as "Hard minimum, enforced, and NOT
 *     rewritten by --update". It appeared in the script once, as a type field,
 *     and was never compared to anything.
 *   - `--update` rewrote `gated` from the baseline's `["lib","routes"]` back to
 *     the `GATED` constant `["lib"]`, silently un-gating routes, and dropped
 *     `floor` and `floorNote` while overwriting the honest `source`.
 *   - the `[gated]` tag in the printed table came from that constant, so the
 *     table said `lib [gated]`, left `routes` untagged, and the gate then failed
 *     on `routes`.
 *
 * Each case builds a fabricated repository root, so nothing depends on what
 * happens to be in this one's coverage directory — which is the whole subject.
 */

import { describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const SCRIPTS = join(REPO, 'scripts');

const BASELINE = {
  generated: '2026-09-04',
  note: 'test',
  source: 'union of the unit and harness lcovs via scripts/merge-coverage.ts',
  maxDropPct: 0.5,
  target: { lib: 90 },
  floor: { lib: 95 },
  floorNote: 'Hard minimum, enforced, and NOT rewritten by --update.',
  gated: ['lib', 'routes'],
  measured: { lib: 100, routes: 100 },
};

/** A root with `libFiles` + `routeFiles` sources on disk and a baseline. */
function fakeRoot(libFiles: number, routeFiles: number): string {
  const root = mkdtempSync(join(tmpdir(), 'e04-cov-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'quality-gates'), { recursive: true });
  mkdirSync(join(root, 'packages', 'engine', 'src', 'lib'), { recursive: true });
  mkdirSync(join(root, 'packages', 'engine', 'src', 'routes'), { recursive: true });
  mkdirSync(join(root, 'packages', 'engine', 'coverage'), { recursive: true });
  copyFileSync(join(SCRIPTS, 'coverage-gate.ts'), join(root, 'scripts', 'coverage-gate.ts'));
  for (let i = 1; i <= libFiles; i++) {
    writeFileSync(join(root, 'packages/engine/src/lib', `f${i}.ts`), `export const x${i} = 1;\n`);
  }
  for (let i = 1; i <= routeFiles; i++) {
    writeFileSync(
      join(root, 'packages/engine/src/routes', `r${i}.ts`),
      `export const y${i} = 1;\n`,
    );
  }
  writeFileSync(
    join(root, 'quality-gates', 'coverage-baseline.json'),
    `${JSON.stringify(BASELINE, null, 2)}\n`,
  );
  return root;
}

/** An lcov listing `lib` lib files and `routes` route files, each `hit` or not. */
function writeLcov(root: string, lib: number, routes: number, libHit = true): void {
  let out = '';
  for (let i = 1; i <= lib; i++) {
    out += `SF:src/lib/f${i}.ts\nDA:1,${libHit || i > lib / 20 ? 1 : 0}\nend_of_record\n`;
  }
  for (let i = 1; i <= routes; i++) out += `SF:src/routes/r${i}.ts\nDA:1,1\nend_of_record\n`;
  writeFileSync(join(root, 'packages/engine/coverage/lcov.info'), out);
}

async function run(root: string, args: string[] = []): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', 'run', join(root, 'scripts', 'coverage-gate.ts'), ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } as never,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

describe('coverage-gate refuses a report that did not run the code', () => {
  it('will not turn a partial run into a coverage collapse', async () => {
    const root = fakeRoot(20, 20);
    try {
      writeLcov(root, 20, 4); // 4 of 20 route files — the shape of the real leftover

      const { code, out } = await run(root);

      expect(out).toContain('does not cover the code it grades');
      expect(out).toContain('4 of 20 source files');
      expect(code).toBe(1);
      // The verdict it used to print instead.
      expect(out).not.toContain('gated coverage regressed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('proceeds to a verdict on a complete report', async () => {
    const root = fakeRoot(20, 20);
    try {
      writeLcov(root, 20, 20);

      const { code, out } = await run(root);

      expect(out).toContain('OK');
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tags the buckets it actually enforces, not a constant', async () => {
    const root = fakeRoot(20, 20);
    try {
      writeLcov(root, 20, 20);

      const { out } = await run(root);

      // Both are in the baseline's `gated`; the table used to tag only `lib`.
      expect(out).toMatch(/routes\s+\S+%.*\[gated\]/);
      expect(out).toMatch(/lib\s+\S+%.*\[gated\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('enforces the hard floor the baseline says is enforced', async () => {
    const root = fakeRoot(20, 20);
    try {
      // A complete report, so the guard above lets it through — and lib at 50%,
      // well under the floor of 95 but only 50pt below `measured`, so the drift
      // check alone would also have caught it. The message is what separates
      // them, and the floor is the one that survives a rewritten `measured`.
      let out = '';
      for (let i = 1; i <= 20; i++) {
        out += `SF:src/lib/f${i}.ts\nDA:1,${i <= 10 ? 1 : 0}\nend_of_record\n`;
      }
      for (let i = 1; i <= 20; i++) out += `SF:src/routes/r${i}.ts\nDA:1,1\nend_of_record\n`;
      writeFileSync(join(root, 'packages/engine/coverage/lcov.info'), out);

      const { code, out: res } = await run(root);

      expect(res).toContain('below the hard floor of 95%');
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--update keeps the decisions in the baseline instead of resetting them', async () => {
    const root = fakeRoot(20, 20);
    try {
      writeLcov(root, 20, 20);

      const { code } = await run(root, ['--update']);
      expect(code).toBe(0);

      const after = JSON.parse(
        readFileSync(join(root, 'quality-gates', 'coverage-baseline.json'), 'utf8'),
      );
      // `gated` used to be reset to ["lib"], silently un-gating routes.
      expect(after.gated).toEqual(['lib', 'routes']);
      // `floor` and its note used to be dropped — by the rewrite the note says
      // does not touch them.
      expect(after.floor).toEqual({ lib: 95 });
      expect(after.floorNote).toBeTruthy();
      // And `source` described a run that may not have happened.
      expect(after.source).toContain('coverage/lcov.info');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
