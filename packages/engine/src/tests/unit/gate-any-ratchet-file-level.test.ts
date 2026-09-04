/**
 * `any-ratchet` against the suppression spelling it could not see.
 *
 * The ratchet's own docstring says the loophole it exists to close is "silence
 * the error with a fresh `// biome-ignore` comment". It counted exactly that
 * spelling. Biome accepts two more — one for a whole file, one for a range —
 * and both were invisible to it.
 *
 * Measured on 2026-09-04 during the E04 review, in this order:
 *
 *   1. a probe file with three bare `any` → `biome lint` reports three
 *   2. the same file with the file-level suppression on line 1 → reports ZERO,
 *      so Biome honours it
 *   3. `any-ratchet` over that tree → "OK — total suppressions 1137
 *      (baseline 1137)", having counted none of the three
 *
 * Counting the marker would not have been a repair. A count-based ratchet holds
 * the line only while one marker equals one violation, and the file-level form
 * buys an unbounded number: the debt could grow without moving a single count,
 * which is the one thing the gate promises cannot happen. So the spelling is
 * refused outright, and this is the case that would have caught it.
 *
 * Runs against a fabricated repository root rather than this one — the same
 * approach `gate-planted-variants.test.ts` takes for section E01. `any-ratchet`
 * takes its corpus from `git ls-files` in the working directory, so the root is
 * a real (empty) git repository with the probe staged.
 *
 * In `unit/` rather than `harness/` deliberately: it needs no database, and the
 * harness lane now refuses to run without one.
 */

import { describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const SCRIPTS = join(REPO, 'scripts');

/** The rule path, assembled — a file that names a marker must not be one. */
const RULE = `lint/suspicious/no${'Explicit'}Any`;

/** A git repository holding the ratchet, its target enumerator and a baseline. */
function fakeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'e04-any-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, 'quality-gates'), { recursive: true });
  copyFileSync(join(SCRIPTS, 'any-ratchet.ts'), join(root, 'scripts', 'any-ratchet.ts'));
  copyFileSync(
    join(SCRIPTS, 'lib', 'any-targets.ts'),
    join(root, 'scripts', 'lib', 'any-targets.ts'),
  );
  // The severity guard reads this before anything else.
  writeFileSync(
    join(root, 'biome.json'),
    `${JSON.stringify({ linter: { rules: { suspicious: { noExplicitAny: 'error' } } } }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'quality-gates', 'any-baseline.json'),
    `${JSON.stringify({ generated: '2026-09-04', note: 'test', total: 0, counts: {} }, null, 2)}\n`,
  );
  return root;
}

function git(root: string, ...args: string[]): void {
  Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'ignore', stderr: 'ignore' });
}

/** Stage `rel` so `git ls-files` reports it; no commit is needed. */
function track(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
  git(root, 'add', '-N', rel);
}

async function runRatchet(root: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', 'run', join(root, 'scripts', 'any-ratchet.ts')], {
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

describe('any-ratchet refuses a suppression that hides an unbounded number of `any`', () => {
  const THREE_ANY =
    'export function a(x: any) { return x; }\n' +
    'export function b(y: any) { return y; }\n' +
    'export function c(z: any) { return z; }\n';

  it('fails on a whole-file suppression, which used to count as zero', async () => {
    const root = fakeRoot();
    try {
      git(root, 'init', '-q');
      track(
        root,
        'packages/engine/src/planted.ts',
        `// biome-ignore-all ${RULE}: planted\n${THREE_ANY}`,
      );

      const { code, out } = await runRatchet(root);

      expect(out).toContain('file-level suppression');
      expect(out).toContain('packages/engine/src/planted.ts');
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails on a ranged suppression too', async () => {
    const root = fakeRoot();
    try {
      git(root, 'init', '-q');
      track(
        root,
        'packages/engine/src/planted.ts',
        `// biome-ignore-start ${RULE}: planted\n${THREE_ANY}// biome-ignore-end ${RULE}: planted\n`,
      );

      const { code, out } = await runRatchet(root);

      expect(code).toBe(1);
      expect(out).toContain('file-level suppression');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still passes on per-occurrence suppressions, which are what the baseline counts', async () => {
    const root = fakeRoot();
    try {
      git(root, 'init', '-q');
      // One marker per violation: the shape the ratchet is built to measure.
      track(
        root,
        'packages/engine/src/planted.ts',
        `// biome-ignore ${RULE}: legacy\nexport function a(x: any) { return x; }\n`,
      );
      writeFileSync(
        join(root, 'quality-gates', 'any-baseline.json'),
        `${JSON.stringify({ generated: '2026-09-04', note: 'test', total: 1, counts: { engine: 1 } }, null, 2)}\n`,
      );

      const { code, out } = await runRatchet(root);

      expect(out).toContain('OK');
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
