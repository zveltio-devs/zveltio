#!/usr/bin/env bun
/**
 * Coverage ratchet — docs/HARDENING-9-PLAN.md item H-02.
 *
 * Parses an lcov report, computes line coverage per engine source subtree, and
 * fails if a GATED subtree drops more than `maxDropPct` below the committed
 * baseline (`refactoring/coverage-baseline.json`). Same philosophy as the
 * `any-ratchet`: the number can only go up (modulo a small tolerance for
 * nondeterministic line hits); erosion is a build failure.
 *
 * WHY ONLY `lib/` IS GATED
 * ------------------------
 * `bun test --coverage` instruments the TEST process. The engine's unit suite
 * imports `src/lib/*` modules directly, so their line coverage is real and
 * stable — that is what we gate. The integration suite, by contrast, drives a
 * SEPARATELY SPAWNED engine over HTTP (see the `integration-tests` job:
 * `bun packages/engine/src/index.ts &` + curl), so route handlers execute in
 * another process and are invisible to the test process's coverage profile.
 * Gating `routes/` on line coverage would therefore gate ~0%, which is noise.
 * Route correctness is instead gated by the integration HTTP contract tests
 * and, once it lands, the H-09 adversarial suite (contract coverage, not line
 * coverage). We still MEASURE and print `routes/` for visibility.
 *
 * Denominator note: lcov only lists files LOADED during the run, so the `lib`
 * percentage is "of the lib lines the unit suite exercises". A lib file no unit
 * test imports is invisible here — driving that number up (and widening what is
 * imported) is the job of waves H-04..H-06 + new unit tests, tracked by raising
 * the baseline toward the 60% target.
 *
 * Usage:
 *   bun run scripts/coverage-gate.ts [lcov-path]           # check (CI)
 *   bun run scripts/coverage-gate.ts [lcov-path] --update  # rewrite baseline
 *
 * Default lcov-path: packages/engine/coverage/lcov.info
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, 'refactoring', 'coverage-baseline.json');
const DEFAULT_LCOV = join('packages', 'engine', 'coverage', 'lcov.info');

/** Subtrees we gate. Everything else is measured-and-printed only. */
const GATED = ['lib'] as const;

type Bucket = { found: number; hit: number; files: number };
type CoverageBaseline = {
  generated: string;
  note: string;
  /** Optional rationale for the target values; preserved across --update rewrites. */
  targetNote?: string;
  source: string;
  maxDropPct: number;
  target: Record<string, number>;
  gated: string[];
  measured: Record<string, number>;
};

/** Map a normalized `src/...` path to a coverage bucket. */
function bucketFor(file: string): string {
  if (file.startsWith('src/lib/')) return 'lib';
  if (file.startsWith('src/routes/')) return 'routes';
  if (file.startsWith('src/')) return 'src-other';
  return 'other';
}

function parseLcov(lcovPath: string): Record<string, Bucket> {
  const text = readFileSync(lcovPath, 'utf8');
  const buckets: Record<string, Bucket> = {};
  let cur = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      cur = line.slice(3).split('\\').join('/');
    } else if (line.startsWith('DA:')) {
      const comma = line.lastIndexOf(',');
      const hits = Number(line.slice(comma + 1));
      const b = bucketFor(cur);
      (buckets[b] ??= { found: 0, hit: 0, files: 0 }).found++;
      if (hits > 0) buckets[b].hit++;
    }
  }
  // files count (distinct SF per bucket) — second pass, cheap and clear.
  const seen: Record<string, Set<string>> = {};
  cur = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      cur = line.slice(3).split('\\').join('/');
      const b = bucketFor(cur);
      (seen[b] ??= new Set()).add(cur);
    }
  }
  for (const b of Object.keys(buckets)) buckets[b].files = seen[b]?.size ?? 0;
  return buckets;
}

function pct(b: Bucket): number {
  return b.found === 0 ? 0 : Math.round((1000 * b.hit) / b.found) / 10;
}

function printTable(buckets: Record<string, Bucket>): Record<string, number> {
  const measured: Record<string, number> = {};
  console.log('[coverage-gate] engine line coverage (unit suite):');
  for (const [b, v] of Object.entries(buckets).sort(([a], [c]) => a.localeCompare(c))) {
    const p = pct(v);
    measured[b] = p;
    const tag = (GATED as readonly string[]).includes(b) ? ' [gated]' : '';
    console.log(
      `  ${b.padEnd(10)} ${String(p).padStart(5)}%  (${v.hit}/${v.found} lines, ${v.files} files)${tag}`,
    );
  }
  return measured;
}

// ---- main ----
const args = process.argv.slice(2);
const update = args.includes('--update');
const lcovArg = args.find((a) => !a.startsWith('--'));
const lcovPath = join(ROOT, lcovArg ?? DEFAULT_LCOV);

if (!existsSync(lcovPath)) {
  console.error(
    `[coverage-gate] lcov not found at ${lcovPath}\n` +
      'Generate it first:\n' +
      '  cd packages/engine && bun test src/tests/unit --coverage ' +
      '--coverage-reporter=lcov --coverage-dir=coverage',
  );
  process.exit(1);
}

const buckets = parseLcov(lcovPath);
const measured = printTable(buckets);

if (update) {
  const prev: Partial<CoverageBaseline> = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    : {};
  const baseline: CoverageBaseline = {
    generated: new Date().toISOString().slice(0, 10),
    note: 'Engine line coverage ratchet. Gated buckets may not drop more than maxDropPct below `measured`. See docs/HARDENING-9-PLAN.md H-02.',
    // Preserve any human-authored target rationale across automated rewrites.
    ...(prev.targetNote ? { targetNote: prev.targetNote } : {}),
    source: 'bun test src/tests/unit --coverage --coverage-reporter=lcov (lines over loaded files)',
    maxDropPct: 0.5,
    target: prev.target ?? { lib: 60 },
    gated: [...GATED],
    measured,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`[coverage-gate] baseline written (lib=${measured.lib}%).`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(
    '[coverage-gate] no baseline found. Create it with:\n' +
      '  bun run scripts/coverage-gate.ts --update',
  );
  process.exit(1);
}

const baseline: CoverageBaseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const failures: string[] = [];
const gains: string[] = [];

for (const b of baseline.gated) {
  const was = baseline.measured[b] ?? 0;
  const now = measured[b] ?? 0;
  if (now < was - baseline.maxDropPct) {
    failures.push(
      `  ${b}: ${was}% → ${now}%  (dropped ${(was - now).toFixed(1)}pt, max allowed ${baseline.maxDropPct}pt)`,
    );
  } else if (now > was + baseline.maxDropPct) {
    gains.push(`  ${b}: ${was}% → ${now}%  (+${(now - was).toFixed(1)}pt)`);
  }
  const target = baseline.target[b];
  if (target && now < target) {
    console.log(
      `[coverage-gate] ${b} at ${now}% — medium-term target ${target}% (not yet enforced).`,
    );
  }
}

if (failures.length > 0) {
  console.error('[coverage-gate] FAIL — gated coverage regressed:');
  for (const l of failures) console.error(l);
  console.error('\nAdd tests for the code you changed, or discuss the drop in review.');
  process.exit(1);
}

if (gains.length > 0) {
  console.log('[coverage-gate] coverage improved:');
  for (const l of gains) console.log(l);
  console.log('Run `bun run scripts/coverage-gate.ts --update` and commit the raised baseline.');
}

console.log('[coverage-gate] OK.');
