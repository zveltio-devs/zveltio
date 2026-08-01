#!/usr/bin/env bun
/**
 * Gate: the translated core pages stay translated.
 *
 * The Studio ships nine locales with perfect key parity, and the navigation is
 * fully translated — while ~42 core admin pages were hardcoded English. A
 * Romanian operator got a translated menu wrapped around an English product,
 * which reads worse than no translation at all: it looks finished and is not.
 *
 * Translating everything in one pass would mean generating thousands of strings
 * nobody re-reads, so the surface is being converted in tranches. This gate
 * holds the ground already taken: a page on the list below must not gain new
 * hardcoded user-visible text.
 *
 * It checks a LIST rather than the whole directory on purpose. A gate that
 * fails on 42 known-untranslated pages would be switched off in a week, and
 * then it would protect nothing. Move a page onto the list when you translate
 * it.
 *
 * Usage: bun scripts/check-i18n-core.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const STUDIO = join(import.meta.dir, '..', 'packages', 'studio');

/** Pages converted to `m['…']()`. Add to this list as more are translated. */
const TRANSLATED = [
  'src/routes/(admin)/+page.svelte',
  'src/routes/(admin)/collections/+page.svelte',
  'src/routes/(admin)/users/+page.svelte',
  'src/routes/(admin)/api-keys/+page.svelte',
  'src/routes/(admin)/audit/+page.svelte',
  'src/routes/(admin)/mail/+page.svelte',
  // tranche 2
  'src/routes/(admin)/settings/+page.svelte',
  'src/routes/(admin)/permissions/+page.svelte',
  'src/routes/(admin)/flows/+page.svelte',
  'src/routes/(admin)/tenants/+page.svelte',
  'src/routes/(admin)/insights/+page.svelte',
  'src/routes/(admin)/import/+page.svelte',
  'src/routes/(admin)/export/+page.svelte',
  // tranche 3
  'src/routes/(admin)/schema-branches/+page.svelte',
  'src/routes/(admin)/onboarding/+page.svelte',
  'src/routes/(admin)/saved-queries/+page.svelte',
  'src/routes/(admin)/zones/+page.svelte',
  'src/routes/(admin)/zones/[slug]/+page.svelte',
  'src/routes/(admin)/virtual-collections/+page.svelte',
  'src/routes/(admin)/rls/+page.svelte',
  'src/routes/(admin)/marketplace/+page.svelte',
  'src/routes/(admin)/column-permissions/+page.svelte',
  'src/routes/(admin)/rpc/+page.svelte',
  'src/routes/(admin)/edge-functions/+page.svelte',
  // tranche 4 — this completes the hand-written core surface. Everything left
  // untranslated under (admin) is generated from the zveltio-extensions repo
  // and has to be edited there; see biome.json for the generated slugs.
  'src/routes/(admin)/+layout.svelte',
  'src/routes/(admin)/[...extPath]/+page.svelte',
  'src/routes/(admin)/account/+page.svelte',
  'src/routes/(admin)/approvals/+page.svelte',
  'src/routes/(admin)/backup/+page.svelte',
  'src/routes/(admin)/collections/[name]/+page.svelte',
  'src/routes/(admin)/collections/erd/+page.svelte',
  'src/routes/(admin)/extensions/[...path]/+page.svelte',
  'src/routes/(admin)/flows/[id]/+page.svelte',
  'src/routes/(admin)/introspect/+page.svelte',
  'src/routes/(admin)/notifications/+page.svelte',
  'src/routes/(admin)/request-logs/+page.svelte',
  'src/routes/(admin)/settings/storage/+page.svelte',
  'src/routes/(admin)/sql/+page.svelte',
  'src/routes/(admin)/storage/+page.svelte',
  'src/routes/(admin)/templates/+page.svelte',
  'src/routes/(admin)/translations/+page.svelte',
  'src/routes/(admin)/views/+page.svelte',
  'src/routes/(admin)/webhooks/+page.svelte',
];

/**
 * Words that are the same in every locale we ship, or are proper nouns and
 * technical tokens. Flagging `API`, `JSON` or `Zveltio` would train people to
 * ignore the gate.
 */
const ALLOWED = new Set([
  'API',
  'JSON',
  'CSV',
  'SQL',
  'URL',
  'UUID',
  'ID',
  'HTTP',
  'HTTPS',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'Zveltio',
  'OK',
  'UTC',
  'AI',
  'SDK',
  'CLI',
  'RLS',
  'DB',
]);

/**
 * Whole strings that are identifiers or code rather than prose.
 *
 * Role names are keys in Casbin — translating `god → admin` would describe a
 * rule that does not exist. SQL and IANA timezones are the same in every
 * locale, and a sample query is read as code.
 */
const ALLOWED_EXACT: RegExp[] = [
  /^(god|admin|member|employee|manager|client|prod)( → (\*|[a-z]+))?$/,
  /^SELECT /i,
  /^[A-Za-z]+\/[A-Za-z_]+$/, // IANA timezone, e.g. Europe/Bucharest
  // Sample values inside placeholders. `Română` is a locale endonym — a
  // locale's name is written in its own language whatever the UI language is,
  // so translating the example would teach the wrong convention.
  /^(Staging|My Company|Română)$/,
  // A list of identifiers, comma- or slash-separated: "id, name, status",
  // "ui / email / content".
  /^[a-z_][a-z0-9_]*((,| \/) ?[a-z_][a-z0-9_]*)+$/,
  /^\/\*[\s\S]*\*\/$/, // a CSS or JS sample shown as code in a placeholder
  /^(Bearer token|Basic auth)$/, // HTTP auth scheme names (RFC 6750 / 7617)
  /^(GET|POST|PUT|PATCH|DELETE) \//, // an HTTP method and path, e.g. POST /api/rpc/:function
  // ERD legend: a relation-type identifier plus its cardinality, e.g.
  // "m2o / reference (N→1)". Both halves are notation, not prose.
  /^(m2o|o2m|m2m|reference)( \/ (m2o|o2m|m2m|reference))* \([N1](→|↔)[N1]\)$/,
  // Code samples shown in placeholders: a JSON object literal (brace-escaped
  // in the markup) and a comparison expression. Both are read as code.
  /^&#123;(&quot;|&#123;)/,
  / === /,
];

interface Finding {
  file: string;
  line: number;
  text: string;
}

/** Text that a user would read: two or more letters, not an identifier. */
function looksTranslatable(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 3) return false;
  if (ALLOWED.has(t)) return false;
  if (ALLOWED_EXACT.some((re) => re.test(t))) return false;
  // Needs at least one lowercase run — screaming tokens are usually constants.
  if (!/[a-z]{2}/.test(t)) return false;
  // Skip anything that is plainly code or a path.
  if (/^[a-z0-9_.\-/]+$/.test(t)) return false;
  if (t.startsWith('http')) return false;
  return /^[A-Z]/.test(t) || t.split(/\s+/).length > 1;
}

/**
 * Every `m['key']()` in the admin routes must resolve in the catalogue.
 *
 * Paraglide compiles to JS with no .d.ts, so `m` is `any` and `tsc` cannot see
 * a typo. A missing key is not a missing translation — `m['nope']` is
 * `undefined`, and calling it throws a TypeError that blanks the whole page.
 * The hardcoded-text scan below cannot catch this: the page looks perfectly
 * translated in the source. That is exactly how `m['nav.insights']()` shipped
 * on the Insights page and crashed it on render.
 *
 * The scan is repo-wide rather than limited to TRANSLATED, because a broken key
 * crashes a page whether or not that page is finished.
 */
function checkKeyReferences(): string[] {
  const bundle: Record<string, unknown> = JSON.parse(
    readFileSync(join(STUDIO, 'messages', 'en.json'), 'utf-8'),
  );
  const broken: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.svelte')) continue;

      const src = readFileSync(p, 'utf-8');
      src.split('\n').forEach((line, i) => {
        for (const ref of line.matchAll(/m\[(['"])([^'"]+)\1\](\??)/g)) {
          const key = ref[2]!;
          // `m['k']?.()` is a deliberate feature probe with its own fallback.
          if (ref[3] === '?') continue;
          if (!(key in bundle)) {
            broken.push(`${relative(STUDIO, p)}:${i + 1}  m['${key}']`);
          }
        }
      });
    }
  };

  walk(join(STUDIO, 'src', 'routes'));
  return broken;
}

const brokenRefs = checkKeyReferences();
if (brokenRefs.length > 0) {
  console.error(
    `❌ i18n-core: ${brokenRefs.length} message key(s) referenced but not in the catalogue.\n`,
  );
  for (const r of brokenRefs) console.error(`  ${r}`);
  console.error(
    `\nThese throw a TypeError at render and blank the page — they are not\n` +
      `missing translations, they are crashes. Add the key to\n` +
      `packages/studio/messages/core/*.json (all nine locales) and re-run\n` +
      `\`bun run i18n:compile\` in packages/studio to regenerate the bundle.\n`,
  );
  process.exit(1);
}

const findings: Finding[] = [];
for (const rel of TRANSLATED) {
  let src: string;
  try {
    src = readFileSync(join(STUDIO, rel), 'utf-8');
  } catch {
    console.error(`❌ i18n-core: ${rel} is on the translated list but does not exist.`);
    process.exit(1);
  }

  // Blank the <script> block rather than deleting it: only markup is
  // user-visible text, but removing the lines shifts every number after it and
  // a gate that points at the wrong line is worse than no line at all.
  const markup = src.replace(/<script[\s\S]*?<\/script>/g, (block) =>
    '\n'.repeat((block.match(/\n/g) ?? []).length),
  );
  markup.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/>([^<>{}\n]+)</g)) {
      if (looksTranslatable(m[1]!)) {
        findings.push({ file: rel, line: i + 1, text: m[1]!.trim() });
      }
    }
    for (const m of line.matchAll(/(placeholder|title|aria-label|alt)="([^"]+)"/g)) {
      if (looksTranslatable(m[2]!)) {
        findings.push({ file: rel, line: i + 1, text: `${m[1]}="${m[2]}"` });
      }
    }
  });
}

if (findings.length === 0) {
  console.log(
    `✅ i18n-core: every message key resolves; ` +
      `${TRANSLATED.length} page(s) free of hardcoded user-visible text.`,
  );
  process.exit(0);
}

console.error(`❌ i18n-core: ${findings.length} hardcoded string(s) on translated pages.\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`      ${f.text}`);
}
console.error(
  `\nThese pages are translated; new text has to go through the catalogue.\n` +
    `  1. add the key to ALL of packages/studio/messages/*.json (parity is enforced)\n` +
    `  2. use it as {m['your.key']()}\n\n` +
    `If a string genuinely reads the same in every locale (a protocol verb, a\n` +
    `product name), add it to ALLOWED in this script and say why.\n`,
);
process.exit(1);
