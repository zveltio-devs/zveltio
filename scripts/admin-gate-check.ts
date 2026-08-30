#!/usr/bin/env bun
/**
 * Forbid the bare `checkPermission(<user>, 'admin', '*')` in route modules.
 *
 * That call means two different things depending on where it sits, and nothing
 * in the source said which:
 *
 *   - an INSTANCE-wide gate (raw SQL, DDL, role grants, whole-instance backup);
 *   - a TENANT-scoped override ("the owner of this row, or an admin of the
 *     tenant it belongs to").
 *
 * It reads as the first and behaves as the second: the `tenant_admin` Casbin
 * policy is ('*','*','*'), so `obj='admin'` matches and a delegated tenant admin
 * passes. Around twenty route modules were gated that way, which is how a
 * tenant admin could reach user-role changes and, from there, the whole
 * instance.
 *
 * The trap is that the obvious repair — replace every occurrence with
 * requireInstanceAdmin — breaks multi-tenancy, because most of those sites are
 * the second kind and a tenant admin passing them is the intended behaviour.
 * There is no correct bulk answer; each site has to state its meaning. So the
 * bare form is banned and the two named helpers are the only way in:
 *
 *   requireInstanceAdmin(uid) — instance-wide operations
 *   isTenantAdmin(uid)        — tenant-scoped resources
 *
 * SCOPE: the engine's routes at zero tolerance, and the extensions repo on a
 * ratchet. That split is measured, not arbitrary. Counting code lines only —
 * comments quoting the pattern do not count, and the five matches inside
 * `packages/engine/src/routes` are exactly such comments:
 *
 *     packages/engine/src/routes   0 sites
 *     ../zveltio-extensions      111 sites, across 46 files
 *
 * So until now the gate guarded the place where it does not happen and ignored
 * the place where it happens a hundred and eleven times. Found while classifying
 * the tenancy boundary: `zv_prompt_templates` is instance-wide data written
 * through a route gated this way, so a TENANT admin can create rows the whole
 * instance sees — the exact confusion this gate was written to stop.
 *
 * The 111 cannot be fixed in bulk, and the header above says why: each site is
 * either an instance operation or a tenant-scoped override, and only whoever
 * wrote it knows which. So they are frozen at their current count, per file, and
 * the count may shrink but never grow. The way out exists — `isTenantAdmin` and
 * `requireInstanceAdmin` are on the extension context and four extensions
 * already use them — which is what makes this a ratchet rather than a dead end.
 *
 * Run: bun run scripts/admin-gate-check.ts
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireSibling } from './lib/require-sibling.js';

const ROOT = join(import.meta.dir, '..');
const EXT_ROOT = join(ROOT, '..', 'zveltio-extensions');
const BASELINE = join(ROOT, 'quality-gates', 'admin-gate-baseline.json');
const UPDATE = process.argv.includes('--update');
const ROOTS = ['packages/engine/src/routes'];

requireSibling(EXT_ROOT, 'admin-gate-check');

/** `checkPermission(x, 'admin', '*')` with any argument spacing. */
const BARE_GATE = /checkPermission\(\s*[A-Za-z0-9_.]+\s*,\s*'admin'\s*,\s*'\*'\s*\)/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const violations: string[] = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      // Comments may quote the pattern — this file's own docs do.
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (BARE_GATE.test(line)) violations.push(`${file}:${i + 1}  ${trimmed.slice(0, 100)}`);
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\n✗ admin-gate-check: ${violations.length} bare admin check(s) found.\n\n` +
      `Say which one you mean:\n` +
      `  requireInstanceAdmin(uid)  — instance-wide (raw SQL, DDL, roles, backup)\n` +
      `  isTenantAdmin(uid)         — tenant-scoped (rows already isolated by RLS)\n\n` +
      `A tenant_admin passes the bare check, so using it as an instance gate is a\n` +
      `privilege-escalation path; using requireInstanceAdmin on a tenant-scoped\n` +
      `resource locks tenant admins out of their own tenant. Neither is a safe\n` +
      `default, which is why there is no bulk answer.\n\n` +
      violations.map((v) => `  ${v}`).join('\n') +
      '\n',
  );
  process.exit(1);
}

// ── The sibling repo, on a ratchet ─────────────────────────────────────────
//
// Counted per file, not per line: line numbers churn on every unrelated edit
// above, and the number that matters is "did this file grow another one".
const extCounts: Record<string, number> = {};
for (const file of walk(EXT_ROOT)) {
  if (file.includes('/node_modules/') || file.includes('/tests/') || file.endsWith('.test.ts'))
    continue;
  let n = 0;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) continue;
    if (BARE_GATE.test(line)) n++;
  }
  if (n > 0) extCounts[file.slice(EXT_ROOT.length + 1).replace(/\\/g, '/')] = n;
}

if (UPDATE) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        _what:
          "Bare `checkPermission(x, 'admin', '*')` sites in the extensions repo, per file. May shrink, never grow.",
        _why: 'The bare form reads as an instance gate and behaves as a tenant-scoped one, so a tenant_admin passes it. Each site is either an instance operation or a tenant-scoped override and only its author knows which — there is no bulk answer, so they are frozen and new ones are refused.',
        _how_to_fix:
          'Use `requireInstanceAdmin(uid)` for instance-wide operations or `isTenantAdmin(uid)` for tenant-scoped ones. Both are on the extension context; four extensions already use them.',
        _regenerate: 'bun run scripts/admin-gate-check.ts --update',
        counts: extCounts,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[admin-gate] baseline written: ${Object.keys(extCounts).length} file(s).`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(
    `✗ admin-gate-check: baseline missing: ${BASELINE}\n  Run with --update to record one.`,
  );
  process.exit(1);
}
const baseline = (JSON.parse(readFileSync(BASELINE, 'utf-8')) as { counts: Record<string, number> })
  .counts;

const grew: string[] = [];
for (const [file, n] of Object.entries(extCounts)) {
  const was = baseline[file] ?? 0;
  if (n > was) grew.push(`  ${file}: ${was} → ${n}`);
}

if (grew.length > 0) {
  console.error(
    `\n✗ admin-gate-check: ${grew.length} extension file(s) gained a bare admin check.\n\n` +
      'A tenant_admin passes it, so it is not the instance gate it looks like.\n' +
      '  requireInstanceAdmin(uid) — instance-wide\n' +
      '  isTenantAdmin(uid)        — tenant-scoped\n' +
      'Both are on the extension context.\n\n' +
      `${grew.join('\n')}\n`,
  );
  process.exit(1);
}

const extTotal = Object.values(extCounts).reduce((a, b) => a + b, 0);
console.log(
  `✅ admin-gate-check: no bare admin checks in engine route modules; ` +
    `${extTotal} recorded in ${Object.keys(extCounts).length} extension file(s), none new.`,
);
