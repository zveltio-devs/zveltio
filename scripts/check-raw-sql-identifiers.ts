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
const DIRS = targets.length > 0 ? targets : [join(ROOT, '..', 'zveltio-extensions')];

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
    if (!src.includes('sql.raw')) continue;
    // Only inside a `sql.raw` template — a quoted interpolation in a plain
    // string is prose (an error message naming a table), not SQL.
    for (const m of src.matchAll(/sql\.raw\(\s*`([^`]*)`/g)) {
      for (const hit of m[1]!.matchAll(/"\$\{[^}]+\}"/g)) {
        const line = src.slice(0, m.index! + hit.index!).split('\n').length;
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
