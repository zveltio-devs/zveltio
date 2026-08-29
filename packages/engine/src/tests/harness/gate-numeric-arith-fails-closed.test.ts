/**
 * `check-numeric-string-arithmetic` used to exit 0 in three different ways
 * without checking anything: no DATABASE_URL, an unreachable database, and a
 * schema with no numeric columns. A fourth way needed no exit at all — the
 * scan walks the extensions sibling, `tsFiles()` returns `[]` for a directory
 * that is not there, and the run ends `OK — 0 site(s), baseline allows 22`.
 *
 * The audit that found this measured it directly: the meta-gate scored 7/8 on a
 * core-only database and 8/8 once a single `amount numeric` column existed. The
 * gate was never decoration — its reach just tracked whatever happened to be
 * installed, and it said nothing when the reach went to zero.
 *
 * These tests pin the exit codes. The script has no local imports, so a copy of
 * it in a temporary root is a faithful subject.
 *
 * They live in the HARNESS suite, not the unit suite, and that placement is the
 * point: three of them hand the gate a DATABASE_URL and assert on what it says
 * about the schema behind it. In `src/tests/unit` they passed locally — where a
 * database happens to be reachable — and failed in CI, which runs that suite
 * without one. A test that depends on ambient environment is the thing this
 * whole gate exists to refuse, so it does not get to live in the suite that has
 * no database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const GATE = join(REPO, 'scripts', 'check-numeric-string-arithmetic.ts');
const BASELINE = join(REPO, 'quality-gates', 'numeric-string-arithmetic.json');

/** Run the gate and report how it exited, without inheriting our own env. */
async function runGate(
  script: string,
  env: Record<string, string | undefined>,
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', 'run', script], {
    // A directory with no `.env` in it. Bun auto-loads one from the working
    // directory, and the engine package has a `.env` carrying DATABASE_URL —
    // which quietly re-supplies the very variable a case here removes.
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } as never,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

describe('check-numeric-string-arithmetic fails closed', () => {
  it('without DATABASE_URL it fails instead of passing', async () => {
    const { code, out } = await runGate(GATE, { DATABASE_URL: undefined });
    expect(code).toBe(1);
    expect(out).toContain('no DATABASE_URL');
  });

  it('with an unreachable database it fails instead of passing', async () => {
    const { code, out } = await runGate(GATE, {
      // Port 9 discards; nothing answers, so the connection cannot succeed.
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:9/nothing',
    });
    expect(code).toBe(1);
    expect(out).toContain('cannot reach the database');
  });

  describe('when the corpus it was calibrated against is absent', () => {
    let root: string;

    beforeAll(() => {
      // A root holding the script and its baseline, but no extensions sibling —
      // exactly the shape of the CI job that runs this gate.
      root = mkdtempSync(join(tmpdir(), 'numeric-gate-'));
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(join(root, 'quality-gates'), { recursive: true });
      mkdirSync(join(root, 'packages'), { recursive: true });
      copyFileSync(GATE, join(root, 'scripts', 'check-numeric-string-arithmetic.ts'));
      copyFileSync(BASELINE, join(root, 'quality-gates', 'numeric-string-arithmetic.json'));
    });

    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it('fails, naming the files it could not have scanned', async () => {
      const { code, out } = await runGate(
        join(root, 'scripts', 'check-numeric-string-arithmetic.ts'),
        { DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL },
      );
      expect(code).toBe(1);
      expect(out).toContain('corpus this baseline was recorded against is missing');
      expect(out).toContain('ext:finance/invoicing/engine/routes.ts');
    });

    it('does not fall back to reporting OK on an empty scan', async () => {
      const { out } = await runGate(join(root, 'scripts', 'check-numeric-string-arithmetic.ts'), {
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
      });
      expect(out).not.toContain('OK — 0 site(s)');
    });
  });

  it('fails when the live schema lacks a column the baseline keys on', async () => {
    // The core-only case: migrations ran, extensions never did, so none of the
    // finance columns exist and every baselined site is invisible.
    const root = mkdtempSync(join(tmpdir(), 'numeric-gate-cols-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(join(root, 'quality-gates'), { recursive: true });
      mkdirSync(join(root, 'packages'), { recursive: true });
      copyFileSync(GATE, join(root, 'scripts', 'check-numeric-string-arithmetic.ts'));
      writeFileSync(
        join(root, 'quality-gates', 'numeric-string-arithmetic.json'),
        JSON.stringify({ _required_columns: ['zz_column_that_cannot_exist'] }),
      );

      const { code, out } = await runGate(
        join(root, 'scripts', 'check-numeric-string-arithmetic.ts'),
        { DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL },
      );
      expect(code).toBe(1);
      expect(out).toContain('missing columns this gate keys on');
      expect(out).toContain('zz_column_that_cannot_exist');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an empty baseline plus an empty scan still cannot report sites it never saw', async () => {
    // No baseline entries means no corpus to miss — the gate should run, find
    // nothing, and say so honestly rather than exiting on the blindness check.
    const root = mkdtempSync(join(tmpdir(), 'numeric-gate-empty-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(join(root, 'quality-gates'), { recursive: true });
      mkdirSync(join(root, 'packages'), { recursive: true });
      copyFileSync(GATE, join(root, 'scripts', 'check-numeric-string-arithmetic.ts'));
      writeFileSync(join(root, 'quality-gates', 'numeric-string-arithmetic.json'), '{}');

      const { code, out } = await runGate(
        join(root, 'scripts', 'check-numeric-string-arithmetic.ts'),
        { DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL },
      );
      expect(code).toBe(0);
      expect(out).toContain('baseline allows 0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
