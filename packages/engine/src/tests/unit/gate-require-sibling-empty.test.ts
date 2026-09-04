/**
 * `requireSibling` against a sibling that exists and holds nothing.
 *
 * The helper's header states the rule it enforces — *"An absent corpus is not a
 * clean corpus"* — and it tested for the path, not the corpus. `existsSync` is
 * true for an empty directory, so the eight gates that call it went straight
 * past and scanned nothing.
 *
 * Measured on 2026-09-04 during the E04 review, against a fabricated root whose
 * sibling was an empty directory:
 *
 *     [fabricated-success] OK — 0 site(s), baseline allows 0.     exit 0
 *
 * That is the same sentence the gate prints over a real, clean corpus of 51
 * extensions. Nothing distinguishes them.
 *
 * Not a hypothetical state either: an interrupted `git clone` leaves the
 * directory behind, and on the morning this was found `audit-gates.ts` was
 * creating empty directories inside the sibling on every run.
 *
 * The three cases below are the three answers the helper can give. The middle
 * one matters as much as the first: a guard that refuses a real checkout is a
 * guard someone switches off.
 */

import { describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const SCRIPTS = join(REPO, 'scripts');

/**
 * A root with one sibling-scanning gate, plus a sibling directory in whatever
 * state the case wants. `check-fabricated-success` is the subject because it
 * takes no database and no arguments — the guard is the only thing between it
 * and a verdict.
 */
function fakeRoot(): { root: string; sibling: string } {
  const base = mkdtempSync(join(tmpdir(), 'e04-sibling-'));
  const root = join(base, 'zveltio');
  const sibling = join(base, 'zveltio-extensions');
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, 'quality-gates'), { recursive: true });
  mkdirSync(join(root, 'packages'), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  copyFileSync(
    join(SCRIPTS, 'check-fabricated-success.ts'),
    join(root, 'scripts', 'check-fabricated-success.ts'),
  );
  copyFileSync(
    join(SCRIPTS, 'lib', 'require-sibling.ts'),
    join(root, 'scripts', 'lib', 'require-sibling.ts'),
  );
  writeFileSync(
    join(root, 'quality-gates', 'fabricated-success.json'),
    `${JSON.stringify({ counts: {} }, null, 2)}\n`,
  );
  return { root, sibling };
}

async function runGate(
  root: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', 'run', join(root, 'scripts', 'check-fabricated-success.ts')], {
    cwd: root,
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

describe('requireSibling demands a corpus, not a path', () => {
  it('refuses a sibling directory that holds no extension manifest', async () => {
    const { root } = fakeRoot();
    try {
      const { code, out } = await runGate(root);

      expect(out).toContain('no extension manifest');
      expect(code).toBe(1);
      // The old behaviour, which this case exists to keep out.
      expect(out).not.toContain('OK — 0 site(s)');
    } finally {
      rmSync(join(root, '..'), { recursive: true, force: true });
    }
  });

  it('accepts a sibling that holds one, so a real checkout is not refused', async () => {
    const { root, sibling } = fakeRoot();
    try {
      mkdirSync(join(sibling, 'crm'), { recursive: true });
      writeFileSync(join(sibling, 'crm', 'manifest.json'), '{"name":"crm"}\n');

      const { code, out } = await runGate(root);

      expect(out).toContain('OK');
      expect(code).toBe(0);
    } finally {
      rmSync(join(root, '..'), { recursive: true, force: true });
    }
  });

  it('still lets a developer opt out on purpose, with the narrower answer said out loud', async () => {
    const { root } = fakeRoot();
    try {
      const { code, out } = await runGate(root, { ZVELTIO_ALLOW_MISSING_SIBLING: '1' });

      expect(out).toContain('WARNING');
      expect(out).toContain('scanning this repository only');
      expect(code).toBe(0);
    } finally {
      rmSync(join(root, '..'), { recursive: true, force: true });
    }
  });
});
