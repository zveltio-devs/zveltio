/**
 * Merge two (or more) lcov files by UNIONing per-line hit data, then print
 * per-bucket line coverage — the honest combined number when coverage is
 * produced by more than one test lane (unit + the Phase C in-process harness).
 *
 * A line counts as covered if it was hit in ANY input lcov. Buckets mirror
 * coverage-gate.ts (lib / routes / other / src-other), gated on `lib`.
 *
 * Usage:
 *   bun run scripts/merge-coverage.ts <lcov-a> <lcov-b> [<lcov-c> ...]
 *   # e.g. packages/engine/coverage/lcov.info packages/engine/coverage-harness/lcov.info
 *
 * Writes the merged lcov to packages/engine/coverage-merged/lcov.info so
 * coverage-gate.ts can read it (pass that path to the gate).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

interface FileCov {
  /** line number -> hit count (max across inputs) */
  lines: Map<number, number>;
}

function parse(lcovPath: string, into: Map<string, FileCov>): void {
  if (!existsSync(lcovPath)) throw new Error(`lcov not found: ${lcovPath}`);
  const text = readFileSync(lcovPath, 'utf8');
  let current: FileCov | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const file = line.slice(3).replace(/\\/g, '/');
      current = into.get(file) ?? { lines: new Map() };
      into.set(file, current);
    } else if (line.startsWith('DA:') && current) {
      const [ln, hits] = line
        .slice(3)
        .split(',')
        .map((n) => Number(n));
      const prev = current.lines.get(ln!) ?? 0;
      current.lines.set(ln!, Math.max(prev, hits ?? 0));
    } else if (line === 'end_of_record') {
      current = null;
    }
  }
}

function bucketOf(file: string): 'lib' | 'routes' | 'other' | 'src-other' {
  const norm = file.replace(/\\/g, '/');
  const i = norm.indexOf('src/');
  const rel = i >= 0 ? norm.slice(i + 4) : norm;
  if (rel.startsWith('lib/')) return 'lib';
  if (rel.startsWith('routes/')) return 'routes';
  if (rel.startsWith('db/') || rel.startsWith('middleware/') || rel.startsWith('field-types/'))
    return 'other';
  return 'src-other';
}

const inputs = process.argv.slice(2);
if (inputs.length < 1) {
  console.error('usage: bun run scripts/merge-coverage.ts <lcov-a> [<lcov-b> ...]');
  process.exit(1);
}

const merged = new Map<string, FileCov>();
for (const p of inputs) parse(p, merged);

// Per-bucket tallies + serialize the merged lcov.
const buckets: Record<string, { lf: number; lh: number; files: number }> = {};
const out: string[] = [];
for (const [file, cov] of [...merged.entries()].sort()) {
  const b = bucketOf(file);
  const lf = cov.lines.size;
  const lh = [...cov.lines.values()].filter((h) => h > 0).length;
  (buckets[b] ??= { lf: 0, lh: 0, files: 0 }).lf += lf;
  buckets[b]!.lh += lh;
  buckets[b]!.files += 1;

  out.push(`SF:${file}`);
  for (const [ln, hits] of [...cov.lines.entries()].sort((a, b2) => a[0] - b2[0])) {
    out.push(`DA:${ln},${hits}`);
  }
  out.push(`LF:${lf}`);
  out.push(`LH:${lh}`);
  out.push('end_of_record');
}

const outPath = join(ROOT, 'packages/engine/coverage-merged/lcov.info');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${out.join('\n')}\n`);

console.log(`[merge-coverage] merged ${inputs.length} lcov files → ${outPath}\n`);
for (const b of ['lib', 'other', 'routes', 'src-other']) {
  const t = buckets[b];
  if (!t) continue;
  const pct = t.lf ? ((100 * t.lh) / t.lf).toFixed(1) : '0';
  const tag = b === 'lib' ? ' [gated]' : '';
  console.log(
    `  ${b.padEnd(10)} ${String(pct).padStart(5)}%  (${t.lh}/${t.lf} lines, ${t.files} files)${tag}`,
  );
}
