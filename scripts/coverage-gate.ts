#!/usr/bin/env bun
/**
 * Coverage ratchet — docs/private/HARDENING-9-PLAN.md item H-02.
 *
 * Parses an lcov report, computes line coverage per engine source subtree, and
 * fails if a GATED subtree drops more than `maxDropPct` below the committed
 * baseline (`quality-gates/coverage-baseline.json`). Same philosophy as the
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

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, 'quality-gates', 'coverage-baseline.json');
const DEFAULT_LCOV = join('packages', 'engine', 'coverage', 'lcov.info');

/** Subtrees we gate. Everything else is measured-and-printed only. */
const GATED = ['lib'] as const;

type Bucket = { found: number; hit: number; files: number };
type CoverageBaseline = {
  generated: string;
  note: string;
  /** Optional rationale for the target values; preserved across --update rewrites. */
  targetNote?: string;
  /**
   * Hard minimum per bucket. Unlike `measured` this is NOT rewritten by
   * `--update`: it is a decision, not a measurement.
   */
  floor?: Record<string, number>;
  floorNote?: string;
  routesNote?: string;
  /** Fraction of a gated subtree's source files the report must carry. */
  minFileCoverage?: number;
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
      buckets[b] ??= { found: 0, hit: 0, files: 0 };
      buckets[b].found++;
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
      seen[b] ??= new Set();
      seen[b].add(cur);
    }
  }
  for (const b of Object.keys(buckets)) buckets[b].files = seen[b]?.size ?? 0;
  return buckets;
}

function pct(b: Bucket): number {
  return b.found === 0 ? 0 : Math.round((1000 * b.hit) / b.found) / 10;
}

function printTable(
  buckets: Record<string, Bucket>,
  gated: readonly string[],
): Record<string, number> {
  const measured: Record<string, number> = {};
  console.log('[coverage-gate] engine line coverage:');
  for (const [b, v] of Object.entries(buckets).sort(([a], [c]) => a.localeCompare(c))) {
    const p = pct(v);
    measured[b] = p;
    // From the baseline, which is what the loop below actually enforces. The tag
    // used to come from the `GATED` constant while enforcement read
    // `baseline.gated`, so the table printed `lib [gated]` and the gate then
    // failed on `routes` — untagged one line above.
    const tag = gated.includes(b) ? ' [gated]' : '';
    console.log(
      `  ${b.padEnd(10)} ${String(p).padStart(5)}%  (${v.hit}/${v.found} lines, ${v.files} files)${tag}`,
    );
  }
  return measured;
}

/**
 * How many source files a subtree actually has, so the report can be checked
 * against the corpus instead of being believed.
 */
function sourceFileCount(bucket: string): number {
  const dir = join(ROOT, 'packages', 'engine', 'src', bucket);
  if (!existsSync(dir)) return 0;
  let n = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts'))
        n++;
    }
  };
  walk(dir);
  return n;
}

/**
 * Refuse to grade a report that did not run the code it is grading.
 *
 * lcov lists only the files LOADED during the run — this file's own header says
 * so, three paragraphs up, and nothing acted on it. The consequence, measured on
 * 2026-09-04: `packages/engine/coverage/lcov.info` (the UNIT lcov, and this
 * script's default input) carries 8 of the 37 files under `src/routes`, and the
 * gate reported
 *
 *     routes: 73.6% → 13%   (dropped 60.6pt)
 *
 * with the same confidence a real regression would get. Nothing in that line is
 * a measurement of anything.
 *
 * The alarming direction is the lucky one. A partial report whose loaded files
 * happen to be the well-covered ones passes silently, and nobody looks at a
 * gate that says OK. That is the case this guard exists for; the red one merely
 * made it visible.
 *
 * The default input can never be right, either: the baseline's own `source`
 * field says it was measured over the UNION of the unit and harness lcovs, so
 * grading the unit lcov alone compares two different things by construction.
 */
function assertReportCoversCorpus(
  buckets: Record<string, Bucket>,
  gated: string[],
  minRatio: number,
): void {
  const thin: string[] = [];
  for (const b of gated) {
    const onDisk = sourceFileCount(b);
    if (onDisk === 0) continue;
    const inReport = buckets[b]?.files ?? 0;
    const ratio = inReport / onDisk;
    if (ratio < minRatio) {
      thin.push(
        `  ${b}: the report carries ${inReport} of ${onDisk} source files ` +
          `(${Math.round(ratio * 100)}%, minimum ${Math.round(minRatio * 100)}%)`,
      );
    }
  }
  if (thin.length === 0) return;
  console.error('[coverage-gate] FAIL — this report does not cover the code it grades:\n');
  console.error(thin.join('\n'));
  console.error(
    '\n  lcov lists only the files a run LOADED, so a partial run reads as a collapse\n' +
      '  in coverage rather than as a missing measurement. Grade the merged report:\n' +
      '    bun run scripts/merge-coverage.ts packages/engine/coverage/lcov.info \\\n' +
      '        packages/engine/coverage-harness/lcov.info\n' +
      '    bun run scripts/coverage-gate.ts packages/engine/coverage-merged/lcov.info',
  );
  process.exit(1);
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

// The baseline is read before the table so the `[gated]` tag can tell the truth,
// and before `--update` so a rewrite preserves the decisions in it.
const prevBaseline: Partial<CoverageBaseline> = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  : {};
const gatedBuckets = prevBaseline.gated ?? [...GATED];

const measured = printTable(buckets, gatedBuckets);

// Before any verdict, including a baseline rewrite: a report that did not run
// the code must not become the number everything else is compared against.
assertReportCoversCorpus(buckets, gatedBuckets, prevBaseline.minFileCoverage ?? 0.7);

if (update) {
  const prev = prevBaseline;
  const baseline: CoverageBaseline = {
    generated: new Date().toISOString().slice(0, 10),
    note: 'Engine line coverage ratchet. Gated buckets may not drop more than maxDropPct below `measured`. See docs/private/HARDENING-9-PLAN.md H-02.',
    // Preserve any human-authored target rationale across automated rewrites.
    ...(prev.targetNote ? { targetNote: prev.targetNote } : {}),
    // The report this number actually came from, not a fixed sentence about the
    // unit suite. `--update` used to overwrite an honest provenance — "union of
    // the unit and harness lcovs via merge-coverage.ts" — with a claim about a
    // run that may not have happened.
    source: `lines over the files loaded in ${lcovArg ?? DEFAULT_LCOV}`,
    maxDropPct: prev.maxDropPct ?? 0.5,
    target: prev.target ?? { lib: 60 },
    // Decisions, not measurements: preserved across a rewrite. `gated` used to
    // be reset to the GATED constant, which silently dropped `routes` from
    // enforcement; `floor` and its note were dropped entirely, while the note
    // itself says the floor is "NOT rewritten by --update".
    gated: prev.gated ?? [...GATED],
    ...(prev.floor ? { floor: prev.floor } : {}),
    ...(prev.floorNote ? { floorNote: prev.floorNote } : {}),
    ...(prev.routesNote ? { routesNote: prev.routesNote } : {}),
    ...(prev.minFileCoverage !== undefined ? { minFileCoverage: prev.minFileCoverage } : {}),
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

  // The floor, which the baseline calls "Hard minimum, enforced" and which no
  // line of this script read. It was a type field and nothing else: declared on
  // line 57, never compared to anything, and dropped by `--update` — the same
  // note promising it is "NOT rewritten by --update".
  //
  // It exists because `measured` is legitimately rewritten whenever the corpus
  // changes shape, and the note says why that matters: "Defensible one at a
  // time, those rewrites accumulate downward, so a number that only moves
  // relative to itself can walk anywhere." A ratchet with no floor is exactly
  // that number.
  const floor = baseline.floor?.[b];
  if (floor !== undefined && now < floor) {
    failures.push(
      `  ${b}: ${now}% is below the hard floor of ${floor}% (a decision, not a measurement — see floorNote)`,
    );
    continue;
  }

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
