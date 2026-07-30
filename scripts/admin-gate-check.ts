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
 * Run: bun run scripts/admin-gate-check.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['packages/engine/src/routes'];

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

console.log('✅ admin-gate-check: no bare admin checks in route modules.');
