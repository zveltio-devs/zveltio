#!/usr/bin/env bun
/**
 * Can an operator find out what this engine reads?
 *
 * Fifty-nine environment variables were read by `packages/engine/src` and named
 * in neither `.env.example` nor `docs/platform/configuration.md`. Sixteen of
 * them switched a guarantee off — plaintext storage of fields marked
 * `encrypted: true`, the SSRF guard inside worker extensions, third-party
 * extension isolation, the fail-closed gate in front of every `/ext/*` route,
 * anonymous access to `/metrics`, rate-limit exemption by CIDR. Each is a
 * deliberate hatch and each was correctly implemented; what was missing was any
 * way to enumerate them.
 *
 * That matters for this product specifically. The stated market is companies and
 * public institutions running self-hosted, and "what can weaken this
 * deployment?" is a question they are required to answer. An answer that begins
 * "grep the source" is not one.
 *
 * The documentation itself was also wrong where it existed: the `METRICS_TOKEN`
 * row said unset metrics are "public (acceptable behind a firewall)" while the
 * code fails CLOSED and returns 403. A gate that only counts would not have
 * caught that, and nothing here claims to — this checks that every variable is
 * REACHABLE, and a human still has to make each description true.
 *
 * ── What counts as documented ─────────────────────────────────────
 *
 * A mention in `.env.example` (as `NAME=`) or anywhere in
 * `docs/platform/configuration.md` inside backticks. Deliberately loose: the
 * point is that a reader searching either file finds the name, not that it sits
 * in a table cell of a particular shape.
 *
 * Test-only variables are exempt by prefix and by an explicit list, because a
 * fixture's env var is not configuration and documenting it would be noise.
 *
 * Ratcheted: the count of undocumented variables may fall, never rise.
 *
 * Usage:
 *   bun run scripts/check-env-documented.ts            # gate
 *   bun run scripts/check-env-documented.ts --report   # list them
 *   bun run scripts/check-env-documented.ts --update   # rewrite the baseline
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const ENGINE_SRC = join(ROOT, 'packages/engine/src');
const ENV_EXAMPLE = join(ROOT, '.env.example');
const CONFIG_DOC = join(ROOT, 'docs/platform/configuration.md');
const BASELINE = join(ROOT, 'quality-gates', 'env-documented.json');

const REPORT = process.argv.includes('--report');
const UPDATE = process.argv.includes('--update');

/**
 * Names that are not this engine's configuration.
 *
 * `NODE_ENV`, `CI` and the `PG*` family are the platform's; `TMPDIR` is POSIX.
 * The rest are read only by fixtures — `BRAND_NEW_SECRET` and the two
 * `ZVELTIO_EXT_*` names exist to prove that extension config is namespaced, and
 * documenting them would tell an operator to set something that does nothing.
 */
const NOT_CONFIGURATION = new Set([
  'NODE_ENV',
  'CI',
  'HOME',
  'PATH',
  'TMPDIR',
  'BRAND_NEW_SECRET',
  'ENABLE_MARKETPLACE_INTEGRATION_TESTS',
  'ZVELTIO_EXT_FINANCE_BANKING_FOO',
  'ZVELTIO_EXT_SEARCH_MEILISEARCH_URL',
]);

const EXEMPT_PREFIX = [/^TEST_/, /^PG(HOST|USER|PASSWORD|PORT|DATABASE)$/, /^npm_/, /^BUN_/];

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === 'studio-dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      // Tests set env vars to exercise branches; that is not configuration.
      if (e === 'tests' || e === 'testing') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.includes('.test.')) {
      out.push(p);
    }
  }
}

/** Every `process.env.NAME` and `process.env['NAME']`, with where it was read. */
function readsByName(): Map<string, Set<string>> {
  const files: string[] = [];
  walk(ENGINE_SRC, files);
  const found = new Map<string, Set<string>>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // Comments are stripped first: this file's OWN prose names several of these
    // variables, and a mention is not a read. Measured — `SECRET_KEY` was
    // reported as read by the very comment recording its removal.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const re = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/g;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: the standard exec loop
    while ((m = re.exec(code)) !== null) {
      const name = (m[1] ?? m[2]) as string;
      const set = found.get(name) ?? new Set<string>();
      set.add(relative(ROOT, f));
      found.set(name, set);
    }
  }
  return found;
}

function documented(): Set<string> {
  const names = new Set<string>();
  if (existsSync(ENV_EXAMPLE)) {
    for (const m of readFileSync(ENV_EXAMPLE, 'utf8').matchAll(/^#?\s*([A-Z_][A-Z0-9_]*)\s*=/gm)) {
      names.add(m[1]!);
    }
  }
  if (existsSync(CONFIG_DOC)) {
    for (const m of readFileSync(CONFIG_DOC, 'utf8').matchAll(/`([A-Z_][A-Z0-9_]{2,})/g)) {
      names.add(m[1]!);
    }
  }
  return names;
}

const reads = readsByName();
if (reads.size === 0) {
  console.error('[env-documented] FAIL — no `process.env` reads found in packages/engine/src.');
  console.error('  That is a broken scan, not a clean tree: this gate would pass over anything.');
  process.exit(1);
}

const docs = documented();
const missing = [...reads.keys()]
  .filter((n) => !NOT_CONFIGURATION.has(n))
  .filter((n) => !EXEMPT_PREFIX.some((re) => re.test(n)))
  .filter((n) => !docs.has(n))
  .sort();

if (REPORT) {
  console.log(
    `[env-documented] ${reads.size} variable(s) read, ${docs.size} named in .env.example or configuration.md.`,
  );
  if (missing.length === 0) console.log('  Every one of them is documented.');
  for (const n of missing) {
    console.log(`  ${n.padEnd(42)} ${[...(reads.get(n) ?? [])].slice(0, 2).join(', ')}`);
  }
  process.exit(0);
}

const baseline: { undocumented: string[] } = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, 'utf8'))
  : { undocumented: [] };

if (UPDATE) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        _what:
          'Environment variables packages/engine/src reads that appear in neither .env.example ' +
          'nor docs/platform/configuration.md. The list may shrink, never grow.',
        _why_it_has_a_gate:
          'There were 59, and 16 of them switched a guarantee off — plaintext encrypted fields, ' +
          'the worker SSRF guard, third-party extension isolation, the /ext/* auth gate, ' +
          'anonymous /metrics, rate-limit exemption by CIDR. Every one deliberate, none findable. ' +
          'For a product sold to institutions running it themselves, that list is a deliverable.',
        _how_to_fix:
          'Add the variable to docs/platform/configuration.md — under "Escape hatches" if it ' +
          'weakens a guarantee — or to .env.example if an operator would normally set it.',
        _regenerate: 'bun run scripts/check-env-documented.ts --update',
        undocumented: missing,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[env-documented] baseline written — ${missing.length} undocumented.`);
  process.exit(0);
}

const allowed = new Set(baseline.undocumented);
const fresh = missing.filter((n) => !allowed.has(n));

if (fresh.length > 0) {
  console.error('[env-documented] FAIL — read by the engine, documented nowhere:\n');
  for (const n of fresh) {
    console.error(`  ${n}`);
    for (const f of [...(reads.get(n) ?? [])].slice(0, 3)) console.error(`      ${f}`);
  }
  console.error(
    '\n  Add it to docs/platform/configuration.md — under "Escape hatches" if it turns\n' +
      '  a guarantee off — or to .env.example if an operator would normally set it.',
  );
  process.exit(1);
}

console.log(
  `[env-documented] OK — ${reads.size} variable(s) read, ${missing.length} undocumented (baseline allows ${allowed.size}).`,
);
