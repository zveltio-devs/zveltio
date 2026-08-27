#!/usr/bin/env bun
/**
 * No quoted interpolation inside a `sql.raw` template.
 *
 * `` sql.raw(`DROP POLICY IF EXISTS "${policy}" ON ${q(table)}`) `` — a name
 * containing a double quote breaks out of the quoting. The route this came from
 * is instance-admin-only, so it is not an escalation; it is still broken SQL,
 * and "the caller was already privileged" is a reason to expect correct
 * statements rather than to accept incorrect ones.
 *
 * This gate exists because the manual sweep that fixed eleven such sites missed
 * a twelfth. That sweep enumerated variable NAMES — schema, name, table, role —
 * and `policy` was not on the list. Enumerating names is the mistake; the
 * pattern is what to match, and a machine does not get bored on the twelfth.
 *
 * Correct spelling is an escaper: `${q(policy)}`, which doubles embedded quotes.
 *
 * Scoped to the EXTENSIONS repo on purpose. The engine guards the same shape a
 * different way — `SAFE_NAME.test(field)` before the interpolation, or a name
 * built from `sanitizeIdentifier` — and every engine site this pattern matches
 * was checked by hand and is guarded. Flagging correct code is how a gate gets
 * switched off, so it watches the place where the `q()` convention is the rule.
 *
 * Usage:
 *   bun run scripts/check-raw-sql-identifiers.ts [dir ...]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'));
// This repository too, not only the sibling. The default was the extensions repo
// alone, so a quoted interpolation inside `sql.raw` in the engine or the Studio
// was never looked at — nine of them exist today and the gate had never seen one.
const DIRS =
  targets.length > 0 ? targets : [join(ROOT, 'packages'), join(ROOT, '..', 'zveltio-extensions')];

/**
 * What counts as having checked the name before interpolating it.
 *
 * A regex test on the value, membership of a literal list, an inline strip of
 * everything but word characters, or a named assertion helper. Deliberately
 * generous: a missed guard costs a finding nobody reads, while demanding the
 * escaper everywhere costs churn on code that is already correct.
 */
const GUARDED =
  /\.test\(|\.includes\(|assertSafe|safeIdent|SAFE_NAME|validate[A-Z]\w*\(|replace\(\s*\/\[\^/;
// 20, not 8. A function that validates a name once at the top and interpolates
// it twice puts the second use well outside a short window —
// `fail-closed-tenant.ts` tests at line 17 and interpolates at 22 and 31. The
// guard has to stay inside the same function to be meaningful, and twenty lines
// is about as long as one of these is.
const LOOKBACK = 20;

/**
 * The escape hatch, in the shape this repository already uses for
 * `// fabricated-ok:`. A name validated far above its use, or one this code
 * built from parts it controls, is safe in a way twenty lines of lookback
 * cannot see — and the reason belongs written down next to it rather than
 * rediscovered by whoever reads the finding next.
 */
const REVIEWED_OK = /^\s*\/\/\s*raw-ident-ok:\s*\S/;

/**
 * A whole-file review, for a module that is one pipeline from one validated
 * input. `ghost-ddl.ts` derives four identifiers from a single table name and
 * threads them through nineteen statements; annotating each is noise, and an
 * attempt to do it mechanically put `//` comments inside SQL template literals,
 * which is a syntax error rather than a comment.
 *
 * Coarse on purpose and therefore rationed: it must carry a reason, and a file
 * claiming it should be one whose entry points validate. If this starts
 * appearing on files that simply have a lot of findings, it has become an
 * excuse and should be taken away again.
 */
const FILE_REVIEWED_OK = /\/\/\s*raw-ident-ok-file:\s*\S/;

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const findings: string[] = [];
for (const dir of DIRS) {
  for (const file of tsFiles(dir)) {
    const src = readFileSync(file, 'utf8');
    // `sql\s*\.\s*raw` here too: a call written across two lines as `sql`
    // then `.raw(` was skipped by the substring test before the regex below
    // ever ran, so widening only the regex changed nothing.
    if (!/sql\s*\.\s*raw/.test(src)) continue;
    // Searched over the whole file, not a prefix: this module's header comment
    // runs past four thousand characters.
    if (FILE_REVIEWED_OK.test(src)) continue;
    // Only inside a `sql.raw` template — a quoted interpolation in a plain
    // string is prose (an error message naming a table), not SQL.
    const lines = src.split('\n');
    // `sql\s*\.\s*raw` — the pattern used to demand `sql.raw(` with nothing
    // between, so a call written across two lines as `sql` then `.raw(` was
    // invisible to it. ghost-ddl.ts has exactly that shape, with TWO quoted
    // interpolations, and the gate had never seen either.
    for (const m of src.matchAll(/sql\s*\.\s*raw\(\s*`([^`]*)`/g)) {
      for (const hit of m[1]!.matchAll(/"\$\{[^}]+\}"/g)) {
        const line = src.slice(0, m.index! + hit.index!).split('\n').length;
        // A guard in the lines just above is the other correct answer, and the
        // note at the top of this file already said so while the check did not
        // look for it. Pointed at this repository, the pattern alone produced
        // nine findings and every one was safe: a regex test immediately before
        // the interpolation, membership of a literal allow-list, or a name this
        // code generated itself. A gate whose every finding is a false positive
        // does not get read.
        // Three lines, not one: a reason worth writing is usually a sentence
        // that wraps, and an annotation that only counts on one line quietly
        // stops counting the moment somebody explains themselves properly.
        const above = lines.slice(Math.max(0, line - 4), line - 1);
        if (above.some((l) => REVIEWED_OK.test(l))) continue;
        const before = lines.slice(Math.max(0, line - 1 - LOOKBACK), line).join('\n');
        if (GUARDED.test(before)) continue;
        findings.push(`  ${file.replace(`${ROOT}/`, '')}:${line}  ${hit[0]}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('[raw-sql-identifiers] FAIL — quoted interpolation inside sql.raw:');
  for (const f of findings) console.error(f);
  console.error('\nUse an identifier escaper — q(name) — which doubles embedded quotes.');
  process.exit(1);
}

console.log('[raw-sql-identifiers] OK — every identifier in a sql.raw template is escaped.');
