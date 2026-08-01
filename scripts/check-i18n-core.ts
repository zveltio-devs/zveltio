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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  /^(Staging|My Company)$/, // sample values inside placeholders
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
  console.log(`✅ i18n-core: ${TRANSLATED.length} page(s) free of hardcoded user-visible text.`);
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
