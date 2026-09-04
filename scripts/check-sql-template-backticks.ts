#!/usr/bin/env bun
/**
 * No backtick inside a `sql` template literal.
 *
 * A backtick ends the template. Written inside an SQL `--` comment it looks
 * completely ordinary — quoting an identifier the way prose does — and the file
 * then fails to parse somewhere further down, with an error that points at the
 * wrong line. It cost four separate detours in one session before the pattern
 * was obvious enough to automate:
 *
 *     await sql`
 *       -- DML on all of `public` is what made this reachable   ← ends here
 *       GRANT ...
 *     `
 *
 * `tsc` does catch it, eventually, as `TS1005: ',' expected` several lines
 * later. This names the actual cause at the actual line.
 *
 * Usage:
 *   bun run scripts/check-sql-template-backticks.ts [dir ...]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const EXT_ROOT = join(ROOT, '..', 'zveltio-extensions');
const DIRS =
  targets.length > 0 ? targets : [join(ROOT, 'packages'), join(ROOT, 'scripts'), EXT_ROOT];

/**
 * Whether the sibling was actually there, so the success line can say so.
 *
 * This gate does NOT call `requireSibling`, and after measuring it on
 * 2026-09-04 that stays deliberate: unlike the five gates that do, its subject
 * is this repository — `packages` and `scripts` — with the extensions repo as an
 * extra. Refusing to run for a developer who has only this checkout would cost
 * more than the narrower answer is worth.
 *
 * What was not defensible is the SENTENCE. Run from a checkout with no sibling
 * beside it, the gate printed "OK — no backticks inside SQL template comments"
 * having never opened half its default corpus — the same "absent corpus read as
 * clean corpus" the other five were fixed for, arriving through the success
 * message rather than the exit code. CI's Lint job clones the sibling, so CI was
 * always honest; `prepush` and every local run were not.
 */
const siblingScanned = targets.length > 0 || existsSync(EXT_ROOT);

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const findings: string[] = [];
for (const dir of DIRS) {
  for (const file of tsFiles(dir)) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    let inTemplate = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Entering: a line that opens `sql`` ` (or sql.raw`) and does not close it.
      if (!inTemplate) {
        if (/\bsql(?:\.raw)?\s*<[^>]*>\s*`|\bsql(?:\.raw)?\s*`/.test(line)) {
          // Count backticks after the opener; an odd total leaves it open.
          const after = line.slice(line.search(/\bsql(?:\.raw)?\s*(?:<[^>]*>)?\s*`/));
          if ((after.match(/`/g) ?? []).length % 2 === 1) inTemplate = true;
        }
        continue;
      }
      // Inside: an SQL comment must not contain one.
      const trimmed = line.trim();
      if (trimmed.startsWith('--') && line.includes('`')) {
        findings.push(`  ${file.replace(`${ROOT}/`, '')}:${i + 1}  ${trimmed.slice(0, 72)}`);
      }
      if (line.includes('`') && !trimmed.startsWith('--')) inTemplate = false;
    }
  }
}

if (findings.length > 0) {
  console.error('[sql-backticks] FAIL — backtick inside an SQL comment in a template literal:');
  for (const f of findings) console.error(f);
  console.error('\nA backtick ends the template. Write the identifier without quoting it.');
  process.exit(1);
}

console.log(
  '[sql-backticks] OK — no backticks inside SQL template comments' +
    (siblingScanned
      ? '.'
      : ' in this repository.\n' +
        `  NOTE: no sibling checkout at ${EXT_ROOT}, so the extensions repo — part of this\n` +
        "  gate's default corpus — was not scanned. An absent corpus is not a clean one."),
);
