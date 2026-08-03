#!/usr/bin/env bun
/**
 * Gate: a security rule is implemented once.
 *
 * The audit rounds of 2026-08-02/03 produced twenty-odd real findings, and the
 * most serious of them were the same bug wearing different clothes: a rule that
 * already existed as a named helper, written out by hand somewhere else, with a
 * piece missing.
 *
 *   - edge functions re-checked an API key — hash, `is_active`, expiry — and
 *     left out the tenant comparison, so one tenant's key ran another's code;
 *   - cursor pagination re-applied RLS filters over `condition.op` and covered
 *     `eq`/`neq` only, so a policy written with `in` evaporated behind
 *     `?cursor=`;
 *   - `GET /:id` had a THIRD copy of that same loop with the same gap;
 *   - sync pull deleted `colAccess.hidden` by hand and never touched
 *     `readOnly`;
 *   - drafts published by spreading a caller-supplied JSON object into an
 *     UPDATE, where the sync route strips a protected set first.
 *
 * None of these were subtle in hindsight and none were found by review. Each was
 * found by an auditor reading one file closely, months apart, and each cost a
 * release. What they have in common is mechanical enough to grep for: code that
 * re-derives an answer a helper already knows.
 *
 * The detectors below are deliberately narrow. A gate that fires on legitimate
 * code gets switched off within a week, and then it protects nothing — so each
 * one encodes a signature taken from an actual incident, and the canonical
 * implementation is exempted by path rather than by cleverness.
 *
 * Usage: bun scripts/check-duplicate-rules.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const ENGINE_SRC = join(ROOT, 'packages/engine/src');

interface Rule {
  /** Short name shown in the failure. */
  id: string;
  /** Fires when this matches a line. */
  pattern: RegExp;
  /** Paths that ARE the canonical implementation, relative to packages/engine/src. */
  canonical: string[];
  /** What to call instead. */
  use: string;
  /** The incident this came from, so the next reader knows it is not theoretical. */
  because: string;
}

const RULES: Rule[] = [
  {
    id: 'rls-filter-loop',
    // A manual dispatch over a filter condition's operator. Every hand-written
    // copy of this so far has covered the comparison operators and silently
    // dropped `in`/`not_in`.
    // The identifier varies — `condition`, `cond`, `f`, `filter` — so match on
    // the shape instead. The zones render path spelled it `f.op === 'eq'` and
    // slipped past a version of this rule that only knew the first two names,
    // which is a fair warning about naming the variable rather than the shape.
    pattern: /\b\w+\.op\s*===\s*['"](?:eq|neq|gt|lt|gte|lte|in|not_in)['"]/,
    canonical: [
      'lib/tenancy/rls.ts',
      'db/dynamic.ts',
      // `matchesSub` is not a copy of the RLS matcher — it applies the
      // SUBSCRIBER'S OWN `?filter=`, which they asked for, and it runs inside
      // the synchronous SSE fan-out. `matchesRlsFilters` throws on an operator
      // it cannot apply, which is right for a policy that must not silently
      // fail open and wrong here: it would break delivery for every subscriber
      // on the connection. The row POLICIES on that path go through the shared
      // helper (see the `access` map on StreamSub); this is the other, weaker
      // filter sitting next to it.
      'routes/realtime.ts',
    ],
    use: '`applyRlsFilters` (SQL) or `matchesRlsFilters` (in memory), or `buildCondition` for one condition',
    because:
      'the cursor branch and GET /:id each grew their own copy covering eq/neq only, so a policy written with `in` applied to the listing and not to those',
  },
  {
    id: 'column-mask-by-hand',
    // Deleting keys named by a column-access set, instead of applying it.
    pattern: /delete\s+\w+\[[^\]]*\]\s*;?\s*$/,
    canonical: ['lib/tenancy/column-permissions.ts'],
    use: '`applyColumnAccess`',
    because:
      'sync pull deleted `colAccess.hidden` in a loop and never touched `readOnly`, so a read-only column shipped as writable',
    // Only interesting when the line is about column access.
  },
  {
    id: 'api-key-lookup',
    // Resolving a raw API key without the shared validator.
    pattern: /selectFrom\(\s*['"]zv_api_keys['"]\s*\)/,
    canonical: ['lib/data/auth.ts', 'routes/admin.ts', 'routes/admin/'],
    use: '`validateApiKey` from `lib/data`',
    because:
      "edge functions kept their own hash + is_active + expiry check and left out the tenant comparison, so one tenant's key invoked another tenant's functions",
  },
];

/** `column-mask-by-hand` is too broad on its own — require the line to be about column access. */
const COLUMN_MASK_CONTEXT = /hidden|readOnly|colAccess|columnAccess/;

interface Finding {
  file: string;
  line: number;
  rule: Rule;
  text: string;
}

const findings: Finding[] = [];

function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'tests') continue;
      walk(full);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;

    const rel = relative(ENGINE_SRC, full).replace(/\\/g, '/');
    const src = readFileSync(full, 'utf8');
    const lines = src.split('\n');

    for (const rule of RULES) {
      if (rule.canonical.some((c) => rel === c || rel.startsWith(c))) continue;

      lines.forEach((raw, i) => {
        const line = raw.trim();
        if (line.startsWith('//') || line.startsWith('*')) return;
        if (!rule.pattern.test(line)) return;
        if (rule.id === 'column-mask-by-hand' && !COLUMN_MASK_CONTEXT.test(raw)) return;
        findings.push({ file: rel, line: i + 1, rule, text: line.slice(0, 100) });
      });
    }
  }
}

walk(ENGINE_SRC);

if (findings.length === 0) {
  console.log(
    `✅ duplicate-rules: no hand-written copy of a rule that already has a helper ` +
      `(${RULES.length} signatures checked).`,
  );
  process.exit(0);
}

console.error(
  `❌ duplicate-rules: ${findings.length} hand-written copy(ies) of an existing rule.\n`,
);
const byRule = new Map<string, Finding[]>();
for (const f of findings) {
  const list = byRule.get(f.rule.id) ?? [];
  list.push(f);
  byRule.set(f.rule.id, list);
}
for (const [id, list] of byRule) {
  const rule = list[0]!.rule;
  console.error(`  ${id} — use ${rule.use}`);
  console.error(`    why it matters: ${rule.because}`);
  for (const f of list) console.error(`    ${f.file}:${f.line}  ${f.text}`);
  console.error('');
}
console.error(
  `A rule written down twice is a rule that will go missing from one of the\n` +
    `copies. Every finding in this file's header was exactly that, and each one\n` +
    `shipped. Call the helper, or — if this genuinely is a new canonical\n` +
    `implementation — add its path to \`canonical\` and say why in the commit.\n`,
);
process.exit(1);
