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
 *   the installers      write their own .env from a heredoc — they must,
 *                       because they MINT secrets with `openssl rand`, which
 *                       an example file cannot do: scripts/install.sh (the
 *                       get.zveltio.com installer, Docker mode) and
 *                       install/install.sh (native, delegated to by the first)
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
const INSTALLERS = [join(ROOT, 'scripts/install.sh'), join(ROOT, 'install/install.sh')];
const COMPOSE = join(ROOT, 'docker-compose.yml');

/** `NAME=` on a line that also says REQUIRED — the human's own marking. */
const REQUIRED_LINE = /^([A-Z][A-Z0-9_]*)=.*\bREQUIRED\b/gm;

const example = readFileSync(ENV_EXAMPLE, 'utf8');
const installer = INSTALLERS.map((f) => readFileSync(f, 'utf8')).join('\n');
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

/**
 * The bodies of the heredocs that WRITE the `.env`, and nothing else.
 *
 * `^KEY=` against the whole installer was the first spelling, and it answered
 * for the wrong half of the file. The installer mints each secret into a shell
 * variable first — `POSTGRES_PASSWORD=$(gen_secret)` at line 125 — and only then
 * copies it into the heredoc. Measured: append `PLANT_REQUIRED_VAR=$(openssl
 * rand -hex 8)` anywhere in the script, mark it REQUIRED in the example, and the
 * gate reports "produced by an install path" for a variable no `.env` ever
 * receives. That minted-but-never-written shape is precisely the operator-facing
 * bug this gate exists to catch, so the evidence has to be the heredoc.
 */
const envHeredocs = (() => {
  const bodies: string[] = [];
  const lines = installer.split('\n');
  let open = false;
  let terminator = '';
  for (const line of lines) {
    if (!open) {
      // `cat > "${ZVELTIO_DIR}/.env" << EOF` — quoted or not, terminator named.
      const m = line.match(/cat\s*>\s*\S*\.env"?\s*<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/);
      if (m) {
        open = true;
        terminator = m[1]!;
      }
      continue;
    }
    if (line.trim() === terminator) {
      open = false;
      continue;
    }
    bodies.push(line);
  }
  return bodies.join('\n');
})();

if (envHeredocs === '') {
  console.error(
    `✗ ${INSTALLERS.join(', ')} contain no \`cat > …/.env << EOF\` block.\n` +
      `  This gate reads those heredocs to decide what an install produces. With none\n` +
      `  found the scan is broken, not the installer clean — it will not pass silently.`,
  );
  process.exit(1);
}

/** Written into the .env the installer generates. */
const writtenByInstaller = (key: string): boolean => new RegExp(`^${key}=`, 'm').test(envHeredocs);

/**
 * The `environment:` blocks of compose services, and nothing else.
 *
 * `^\s+KEY:\s` matched any mapping key at any indent in the file. Measured: a
 * line `  PLANT_REQUIRED_VAR: {}` under the top-level `volumes:` satisfied it,
 * and the gate reported the variable supplied by compose. A named volume is not
 * a value an engine ever reads.
 */
const composeEnvBlocks = (() => {
  const bodies: string[] = [];
  const lines = compose.split('\n');
  let indent = -1;
  for (const line of lines) {
    if (indent >= 0) {
      const here = line.search(/\S/);
      if (line.trim() === '') continue;
      if (here > indent) {
        bodies.push(line);
        continue;
      }
      indent = -1;
    }
    const m = line.match(/^(\s+)environment:\s*$/);
    if (m) indent = m[1]!.length;
  }
  return bodies.join('\n');
})();

/** Supplied or derived by compose — `KEY: '…'` in a service environment block. */
const suppliedByCompose = (key: string): boolean =>
  new RegExp(`^\\s+${key}:\\s`, 'm').test(composeEnvBlocks);

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
    - the installer should write it  → add it to the .env heredoc in scripts/install.sh (Docker) or install/install.sh (native)
    - compose should derive it       → add it to the service environment block
    - it is not actually mandatory   → drop REQUIRED from the .env.example line
`);
process.exit(1);
