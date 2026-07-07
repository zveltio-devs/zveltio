/**
 * H-16 — release gate. The 1.0 → orphaned-2.0 → 3.0 history reads as instability
 * from the outside; the fix is procedural: a STABLE release is cut when this
 * script says so, not when it feels ready.
 *
 * Prerelease tags (`-alpha/-beta/-rc.`) BYPASS with a warning. A stable tag must
 * pass every check below or the gate exits non-zero and blocks the release.
 *
 * Usage:
 *   bun run scripts/release-gate.ts [version]
 * Version resolves from: argv[2] → GITHUB_REF_NAME → root package.json.
 * Env:
 *   RELEASE_GATE_SKIP_NETWORK=1  skip the gh-API checks (local/offline dry run)
 *   GITHUB_SHA                    commit to check CI runs against (default HEAD)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SKIP_NETWORK = process.env.RELEASE_GATE_SKIP_NETWORK === '1';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as T;
}

async function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

function resolveVersion(): string {
  const argv = process.argv[2];
  if (argv) return argv.replace(/^v/, '');
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME.replace(/^v/, '');
  return readJson<{ version: string }>('package.json').version;
}

const isPrerelease = (v: string): boolean => /-(alpha|beta|rc)\./.test(v);

// ── Checks ───────────────────────────────────────────────────────────────────

async function checkAnyRatchet(): Promise<CheckResult> {
  const r = await run(['bun', 'run', 'scripts/any-ratchet.ts']);
  return {
    name: 'any-ratchet (H-01)',
    ok: r.code === 0,
    detail:
      r.code === 0 ? 'at/below baseline' : (r.out + r.err).trim().split('\n').pop() || 'failed',
  };
}

function checkCoverage(): CheckResult {
  const base = readJson<{
    target: Record<string, number>;
    measured: Record<string, number>;
    gated: string[];
  }>('refactoring/coverage-baseline.json');
  const below: string[] = [];
  for (const bucket of base.gated) {
    const target = base.target[bucket];
    const measured = base.measured[bucket];
    if (target != null && measured != null && measured < target) {
      below.push(`${bucket} ${measured}% < target ${target}%`);
    }
  }
  return {
    name: 'coverage ≥ stable target (H-02)',
    ok: below.length === 0,
    detail: below.length === 0 ? 'all gated buckets meet target' : below.join('; '),
  };
}

function checkMigrationSuperset(): CheckResult {
  // Reuse H-11's invariant: HEAD's migrations must be a strict superset of the
  // last release tag's (no rename/renumber/delete). Runs git synchronously.
  const dir = 'packages/engine/src/db/migrations/sql';
  const tags = Bun.spawnSync(['git', 'tag', '--sort=-creatordate', '--list', 'v*'], { cwd: ROOT });
  const lastTag = new TextDecoder().decode(tags.stdout).trim().split('\n')[0];
  if (!lastTag)
    return { name: 'migration superset (no renumber)', ok: true, detail: 'no prior release tag' };

  const relList = Bun.spawnSync(['git', 'ls-tree', '-r', '--name-only', lastTag, '--', dir], {
    cwd: ROOT,
  });
  const relFiles = new TextDecoder()
    .decode(relList.stdout)
    .trim()
    .split('\n')
    .filter((f) => f.endsWith('.sql'));
  const broken: string[] = [];
  for (const f of relFiles) {
    const relBlob = Bun.spawnSync(['git', 'show', `${lastTag}:${f}`], { cwd: ROOT });
    if (relBlob.exitCode !== 0) continue;
    let headContent: string;
    try {
      headContent = readFileSync(join(ROOT, f), 'utf8');
    } catch {
      broken.push(`removed/renamed: ${f}`);
      continue;
    }
    const relText = new TextDecoder().decode(relBlob.stdout);
    if (Bun.hash(relText) !== Bun.hash(headContent)) broken.push(`edited: ${f}`);
  }
  return {
    name: `migration superset vs ${lastTag}`,
    ok: broken.length === 0,
    detail: broken.length === 0 ? 'strict superset (no renumber)' : broken.join('; '),
  };
}

function checkVersionConsistency(version: string): CheckResult {
  const pkg = readJson<{ version: string }>('package.json').version;
  return {
    name: 'version consistency',
    ok: pkg === version,
    detail: pkg === version ? `package.json = ${version}` : `package.json ${pkg} ≠ tag ${version}`,
  };
}

async function checkRequiredCIGreen(): Promise<CheckResult> {
  if (SKIP_NETWORK)
    return { name: 'required CI green (RC SHA)', ok: true, detail: 'skipped (offline)' };
  const sha = process.env.GITHUB_SHA || (await run(['git', 'rev-parse', 'HEAD'])).out.trim();
  const required = ['Type Check', 'Lint', 'Unit Tests', 'Integration Tests', 'Perf Smoke'];
  const r = await run([
    'gh',
    'api',
    `repos/{owner}/{repo}/commits/${sha}/check-runs`,
    '--paginate',
  ]);
  if (r.code !== 0)
    return {
      name: 'required CI green (RC SHA)',
      ok: false,
      detail: `gh api failed: ${r.err.trim()}`,
    };
  let runs: Array<{ name: string; conclusion: string }> = [];
  try {
    // --paginate concatenates JSON objects; take check_runs from each.
    runs = r.out
      .trim()
      .split('\n')
      .flatMap((line) => {
        try {
          return (JSON.parse(line) as { check_runs?: typeof runs }).check_runs ?? [];
        } catch {
          return [];
        }
      });
  } catch {
    /* fall through */
  }
  const missing: string[] = [];
  for (const name of required) {
    const hit = runs.filter((c) => c.name.startsWith(name));
    if (hit.length === 0) missing.push(`${name}: no run`);
    else if (!hit.some((c) => c.conclusion === 'success')) missing.push(`${name}: not green`);
  }
  return {
    name: 'required CI green (RC SHA)',
    ok: missing.length === 0,
    detail: missing.length === 0 ? `${required.length} required checks green` : missing.join('; '),
  };
}

async function checkLatestSoak(): Promise<CheckResult> {
  if (SKIP_NETWORK)
    return { name: 'latest soak green (H-15)', ok: true, detail: 'skipped (offline)' };
  const r = await run([
    'gh',
    'run',
    'list',
    '--workflow=soak.yml',
    '--limit',
    '1',
    '--json',
    'conclusion,status',
  ]);
  if (r.code !== 0)
    return { name: 'latest soak green (H-15)', ok: false, detail: `gh failed: ${r.err.trim()}` };
  const runs = JSON.parse(r.out || '[]') as Array<{ conclusion: string; status: string }>;
  if (runs.length === 0)
    return { name: 'latest soak green (H-15)', ok: false, detail: 'no soak run found' };
  return {
    name: 'latest soak green (H-15)',
    ok: runs[0]!.conclusion === 'success',
    detail: `latest soak: ${runs[0]!.conclusion || runs[0]!.status}`,
  };
}

async function checkNoOpenP0(): Promise<CheckResult> {
  if (SKIP_NETWORK) return { name: 'no open P0 issues', ok: true, detail: 'skipped (offline)' };
  const r = await run([
    'gh',
    'issue',
    'list',
    '--label',
    'P0',
    '--state',
    'open',
    '--json',
    'number',
  ]);
  if (r.code !== 0)
    return { name: 'no open P0 issues', ok: false, detail: `gh failed: ${r.err.trim()}` };
  const issues = JSON.parse(r.out || '[]') as Array<{ number: number }>;
  return {
    name: 'no open P0 issues',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? 'none open'
        : `${issues.length} open: #${issues.map((i) => i.number).join(', #')}`,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const version = resolveVersion();
  console.log(`[release-gate] evaluating ${version}`);

  if (isPrerelease(version)) {
    console.warn(
      `[release-gate] ⚠ prerelease (${version}) — gate BYPASSED. Stable cuts run the full gate.`,
    );
    return;
  }

  console.log('[release-gate] STABLE tag — running the full gate…\n');
  const checks: CheckResult[] = [
    await checkAnyRatchet(),
    checkCoverage(),
    checkMigrationSuperset(),
    checkVersionConsistency(version),
    await checkRequiredCIGreen(),
    await checkLatestSoak(),
    await checkNoOpenP0(),
  ];

  let failed = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
    if (!c.ok) failed++;
  }
  console.log('');
  if (failed > 0) {
    console.error(
      `[release-gate] BLOCKED: ${failed}/${checks.length} check(s) failed. Not cutting ${version}.`,
    );
    process.exit(1);
  }
  console.log(
    `[release-gate] ✓ all ${checks.length} checks passed — ${version} may be cut stable.`,
  );
}

await main();
