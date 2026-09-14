/**
 * `check-private-docs-untracked` against a `docs/private` that is a SYMLINK.
 *
 * The private working documents live in their own repository. Keeping a copy
 * inside this one and syncing by hand lost data twice: on 2026-09-13 three
 * session records existed only inside an Archon worktree, and the campaign
 * inventory read 30% where the measured figure was 34%. Pointing
 * `docs/private` at the private repository removes the second copy entirely.
 *
 * The gate refused that layout. It probes `docs/private/__gate_probe__.md`
 * through `git check-ignore`, and git answers
 *
 *     fatal: pathspec 'docs/private/__gate_probe__.md' is beyond a symbolic link
 *
 * exiting 128 — which the probe reads as "not ignored". So the gate failed on
 * the arrangement it should prefer: with a symlink the documents are not in
 * this tree at all, which is a stronger guarantee than an ignore rule.
 *
 * The three cases are the three answers the gate can now give. The last one
 * matters as much as the first: an unignored symlink is still committable, and
 * a gate that waved it through would be worse than one that never looked.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const GATE = join(REPO, 'scripts', 'check-private-docs-untracked.ts');

/** A throwaway git repository, plus the private directory in the shape a case wants. */
function fixture(opts: { symlink: boolean; ignored: boolean }): { base: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'pdgate-'));
  const root = join(base, 'repo');
  const outside = join(base, 'private-repo');
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'NOTES.md'), '# private\n');

  for (const cmd of [
    ['git', 'init', '-q', '-b', 'main'],
    ['git', 'config', 'user.email', 'gate@test.invalid'],
    ['git', 'config', 'user.name', 'gate'],
  ]) {
    Bun.spawnSync(cmd, { cwd: root, stdout: 'ignore', stderr: 'ignore' });
  }

  if (opts.symlink) symlinkSync(outside, join(root, 'docs', 'private'));
  else {
    mkdirSync(join(root, 'docs', 'private'), { recursive: true });
    writeFileSync(join(root, 'docs', 'private', 'NOTES.md'), '# private\n');
  }

  // Without a trailing slash: the slash form matches directories only, so it
  // would not cover the symlink. It still covers a real directory.
  writeFileSync(join(root, '.gitignore'), opts.ignored ? 'docs/private\n' : 'node_modules\n');
  writeFileSync(join(root, 'README.md'), '# repo\n');
  Bun.spawnSync(['git', 'add', 'README.md', '.gitignore'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'init'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return { base, root };
}

function runGate(root: string): { code: number; out: string } {
  const p = Bun.spawnSync(['bun', GATE, root], { stdout: 'pipe', stderr: 'pipe' });
  return {
    code: p.exitCode,
    out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  };
}

describe('check-private-docs-untracked — docs/private as a symlink', () => {
  it('accepts a symlink whose path is ignored', () => {
    const { base, root } = fixture({ symlink: true, ignored: true });
    try {
      const { code, out } = runGate(root);
      expect(out).toContain('is a symlink to');
      expect(code).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('still accepts a real directory that is ignored', () => {
    const { base, root } = fixture({ symlink: false, ignored: true });
    try {
      const { code, out } = runGate(root);
      expect(out).toContain('untracked and ignored');
      expect(code).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('refuses a symlink that is NOT ignored — the next `git add` would commit it', () => {
    const { base, root } = fixture({ symlink: true, ignored: false });
    try {
      const { code, out } = runGate(root);
      expect(out).toContain('not ignored');
      expect(code).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
