#!/usr/bin/env bun
/**
 * Gate: every variable `.env.example` marks REQUIRED must actually be produced
 * by an install.
 *
 * ── Why this exists ───────────────────────────────────────────
 *
 * There are three sources for the same file and nothing kept them in step:
 *
 *   .env.example        the reference an operator copies, and a published
 *                       release asset (installation.md curls it)
 *   install/install.sh  writes its own .env from a heredoc — it must, because
 *                       it MINTS secrets with `openssl rand`, which an example
 *                       file cannot do
 *   docker-compose.yml  derives some values from others, e.g.
 *                       VALKEY_URL from VALKEY_PASSWORD
 *
 * `check-env-documented` compares the ENGINE SOURCE against `.env.example` and
 * `configuration.md`, so it catches a new variable nobody documented. It cannot
 * catch the opposite: a variable the example says is mandatory that no install
 * path ever writes, which an operator meets as a failed boot with a value they
 * were told the installer would set.
 *
 * ── Why it is this narrow ─────────────────────────────────────
 *
 * The obvious version — compare the whole key set of the example against the
 * installer — would be wrong. The Docker path writes VALKEY_PASSWORD and lets
 * compose build VALKEY_URL from it; the native path writes VALKEY_URL directly.
 * Those two differ on purpose, and a gate that reports correct differences is
 * switched off after its third false alarm. So this checks one claim only, and
 * it is a claim a human made in `.env.example` by writing REQUIRED:
 *
 *   an operator who runs the installer ends up with a value for every variable
 *   the example calls mandatory.
 *
 * Usage: bun run scripts/check-required-env-installable.ts [--report]
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const ENV_EXAMPLE = join(ROOT, '.env.example');
const INSTALLER = join(ROOT, 'install/install.sh');
const COMPOSE = join(ROOT, 'docker-compose.yml');

/** `NAME=` on a line that also says REQUIRED — the human's own marking. */
const REQUIRED_LINE = /^([A-Z][A-Z0-9_]*)=.*\bREQUIRED\b/gm;

const example = readFileSync(ENV_EXAMPLE, 'utf8');
const installer = readFileSync(INSTALLER, 'utf8');
const compose = readFileSync(COMPOSE, 'utf8');

const required = [...example.matchAll(REQUIRED_LINE)].map((m) => m[1] as string);

if (required.length === 0) {
  console.error(
    `✗ ${ENV_EXAMPLE} marks nothing REQUIRED.\n` +
      `  Either the marking convention changed or the file was truncated. This gate\n` +
      `  reads that marking, so it has nothing to check and will not pass silently.`,
  );
  process.exit(1);
}

/** Written into the .env the installer generates. */
const writtenByInstaller = (key: string): boolean => new RegExp(`^${key}=`, 'm').test(installer);

/** Supplied or derived by compose — `KEY: '…'` in a service environment block. */
const suppliedByCompose = (key: string): boolean =>
  new RegExp(`^\\s+${key}:\\s`, 'm').test(compose);

const missing = required.filter((k) => !writtenByInstaller(k) && !suppliedByCompose(k));

if (process.argv.includes('--report')) {
  for (const k of required) {
    const how = writtenByInstaller(k)
      ? 'install.sh'
      : suppliedByCompose(k)
        ? 'docker-compose.yml'
        : 'NOTHING';
    console.log(`  ${k.padEnd(28)} ${how}`);
  }
}

if (missing.length === 0) {
  console.log(
    `✅ required-env: ${required.length} variable(s) marked REQUIRED in .env.example, ` +
      `each produced by an install path.`,
  );
  process.exit(0);
}

console.error(`\n✗ .env.example marks these REQUIRED and no install path produces them:\n`);
for (const k of missing) console.error(`    ${k}`);
console.error(`
  An operator following installation.md gets a .env without them, and meets it
  as a failed boot for a value they were told would be set.

  Fix whichever is true:
    - the installer should write it  → add it to the heredoc in install/install.sh
    - compose should derive it       → add it to the service environment block
    - it is not actually mandatory   → drop REQUIRED from the .env.example line
`);
process.exit(1);
