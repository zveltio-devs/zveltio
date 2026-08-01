#!/usr/bin/env bun
/**
 * Gate: never branch on a driver-reported affected-row count.
 *
 * This dialect does not report them. `numUpdatedRows` and `numDeletedRows` come
 * back as `0n` whether or not rows changed, and raw `sql` executes omit
 * `numAffectedRows` entirely. Four call sites relied on them and each broke
 * differently:
 *
 *   - `moveToTrash` threw "not found" on every successful delete — the file was
 *     gone and the caller was told the request failed.
 *   - the ghost-DDL backfill copied exactly two batches and reported success,
 *     because one branch defaulted to `?? BATCH_SIZE` and the next to `?? 0`.
 *     A table over 20,000 rows had its ghost swapped in incomplete.
 *   - the garbage collector logged zero however much it purged.
 *   - the ERD layout delete always answered `deleted: 0`.
 *
 * None of those look related in review, and `routes/webhooks.ts` had already
 * discovered the trap and written the workaround as a local comment — which
 * stopped nobody from using the pattern again three files away. A comment is
 * not a control.
 *
 * Use `RETURNING` and count rows. `.returning('id').executeTakeFirst()` for
 * "did this match anything", `.returning(...).execute()` then `.length` for
 * "how many".
 *
 * Usage: bun scripts/check-affected-rows.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SCAN_DIRS = ['packages/engine/src', 'packages/cli/src', 'packages/sdk/src'];

/** The fields the driver does not fill in. */
const BANNED = /\b(numUpdatedRows|numDeletedRows|numAffectedRows|numInsertedOrUpdatedRows)\b/;

/**
 * Tests may reference the fields — pinning the behaviour is the whole point of
 * `dialect-affected-rows.test.ts`, and forbidding the words there would forbid
 * documenting the trap.
 */
function isExempt(rel: string): boolean {
  return rel.includes('/tests/') || rel.endsWith('.test.ts');
}

/** Strip comments so an explanation of the rule is not a violation of it. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const t = line.trimStart();
      return t.startsWith('//') || t.startsWith('*') ? '' : line;
    })
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const findings: { file: string; line: number; text: string }[] = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file);
    if (isExempt(rel)) continue;
    stripComments(readFileSync(file, 'utf-8'))
      .split('\n')
      .forEach((line, i) => {
        if (BANNED.test(line)) findings.push({ file: rel, line: i + 1, text: line.trim() });
      });
  }
}

if (findings.length === 0) {
  console.log('✅ affected-rows: no code branches on a driver-reported row count.');
  process.exit(0);
}

console.error(`❌ affected-rows: ${findings.length} use(s) of an unreported row count.\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`      ${f.text}`);
}
console.error(
  `\nThis dialect does not report affected rows: numUpdatedRows/numDeletedRows are\n` +
    `0n whether or not anything changed, and raw \`sql\` executes omit\n` +
    `numAffectedRows entirely. Count with RETURNING instead:\n\n` +
    `  did it match?   .returning('id').executeTakeFirst()   → row | undefined\n` +
    `  how many?       .returning('id').execute()            → rows.length\n\n` +
    `See packages/engine/src/tests/harness/dialect-affected-rows.test.ts.\n`,
);
process.exit(1);
