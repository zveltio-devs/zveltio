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

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const STUDIO = join(import.meta.dir, '..', 'packages', 'studio');

/** Pages converted to `m['…']()`. Add to this list as more are translated. */
// Five entries left this list when their pages moved to the extensions that own
// them — import, export, edge-functions, approvals, translations. They are still
// checked, by `check-extension-page-ownership.ts` and by the extensions' own
// SDUI i18n validator; they are simply no longer core pages.
//
// Three more left for the same reason when the engine went headless: zones,
// zones/[slug] and views. Their pages are now owned by the extension that
// received portals, and this list naming files that no longer exist is what
// made the gate fail rather than what it is there to catch.
const TRANSLATED = [
  'src/routes/(admin)/collections/[name]/+page.svelte',
  'src/routes/(admin)/collections/[name]/fields/+page.svelte',
  'src/routes/(admin)/collections/[name]/relations/+page.svelte',
  'src/routes/(admin)/ai/chat/+page.svelte',
  'src/routes/(admin)/+page.svelte',
  'src/routes/(admin)/collections/+page.svelte',
  'src/routes/(admin)/users/+page.svelte',
  'src/routes/(admin)/api-keys/+page.svelte',
  'src/routes/(admin)/audit/+page.svelte',
  // mail left when communications/mail went SDUI (schema via [...extPath])
  // tranche 2
  'src/routes/(admin)/settings/+page.svelte',
  'src/routes/(admin)/permissions/+page.svelte',
  'src/routes/(admin)/flows/+page.svelte',
  'src/routes/(admin)/tenants/+page.svelte',
  'src/routes/(admin)/insights/+page.svelte',
  // tranche 3
  'src/routes/(admin)/schema-branches/+page.svelte',
  'src/routes/(admin)/onboarding/+page.svelte',
  'src/routes/(admin)/saved-queries/+page.svelte',
  'src/routes/(admin)/virtual-collections/+page.svelte',
  'src/routes/(admin)/rls/+page.svelte',
  'src/routes/(admin)/marketplace/+page.svelte',
  'src/routes/(admin)/column-permissions/+page.svelte',
  'src/routes/(admin)/rpc/+page.svelte',
  // tranche 4 — this completes the hand-written core surface. Everything left
  // untranslated under (admin) is generated from the zveltio-extensions repo
  // and has to be edited there; see biome.json for the generated slugs.
  'src/routes/(admin)/+layout.svelte',
  'src/routes/(admin)/[...extPath]/+page.svelte',
  'src/routes/(admin)/account/+page.svelte',
  'src/routes/(admin)/backup/+page.svelte',
  'src/routes/(admin)/collections/[name]/+page.svelte',
  'src/routes/(admin)/collections/erd/+page.svelte',
  'src/routes/(admin)/extensions/[...path]/+page.svelte',
  'src/routes/(admin)/flows/[id]/+page.svelte',
  // introspect left when developer/byod went SDUI (schema via [...extPath])
  'src/routes/(admin)/notifications/+page.svelte',
  'src/routes/(admin)/request-logs/+page.svelte',
  'src/routes/(admin)/settings/storage/+page.svelte',
  'src/routes/(admin)/sql/+page.svelte',
  'src/routes/(admin)/storage/+page.svelte',
  'src/routes/(admin)/templates/+page.svelte',
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
/**
 * The shared components too, not only the pages.
 *
 * Those render ON the translated pages, and the gate never looked at them — so
 * `CollectionDataTable.svelte` carried "Delete Record" and "Bulk delete failed"
 * on a screen this check was reporting clean. Forty-two more sat in nine other
 * components. It is the fourth blind spot found in this one gate today; the
 * first three were the `<script>` block, the fixed page list, and pages added to
 * the routes tree without being added to the list.
 *
 * Enumerated rather than listed by hand: a component added tomorrow is covered
 * without anybody remembering to add it, which is exactly how the page list
 * fell eight behind.
 */
function sharedComponents(): string[] {
  const root = join(STUDIO, 'src/lib/components');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.svelte')) out.push(relative(STUDIO, full));
    }
  };
  try {
    walk(root);
  } catch {
    // no components directory — nothing to scan
  }
  return out;
}

const SCANNED = [...TRANSLATED, ...sharedComponents()];

for (const rel of SCANNED) {
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

  // The script block, for the shapes that ARE shown to a person: the fields of a
  // confirm/modal descriptor, and the argument of a toast. Narrow on purpose —
  // a variable named `title` holding a route segment is not a finding, and a
  // gate that reports those stops being read.
  const scriptBlock = /<script[\s\S]*?<\/script>/.exec(src)?.[0] ?? '';
  const startLine = scriptBlock ? src.slice(0, src.indexOf(scriptBlock)).split('\n').length : 0;
  scriptBlock.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(
      /\b(title|message|confirmLabel|cancelLabel|heading|description)\s*:\s*'([^']{3,})'/g,
    )) {
      if (looksTranslatable(m[2]!)) {
        findings.push({ file: rel, line: startLine + i, text: `${m[1]}: '${m[2]}'` });
      }
    }
    for (const m of line.matchAll(/toast\.(?:error|success|warning|info)\(\s*'([^']{3,})'/g)) {
      if (looksTranslatable(m[1]!)) {
        findings.push({ file: rel, line: startLine + i, text: `toast('${m[1]}')` });
      }
    }
  });
}

// A ratchet, because sixty-eight of these already exist and a gate that fails on
// day one gets switched off rather than fixed. New ones are refused; the number
// only goes down. `--update` records where it stands after a translation pass.
const BASELINE_FILE = join(import.meta.dir, '..', 'quality-gates', 'i18n-core-script.json');
const COMPONENT_BASELINE = join(import.meta.dir, '..', 'quality-gates', 'i18n-components.json');
const isScript = (t: string) =>
  /^(title|message|confirmLabel|cancelLabel|heading|description):|^toast\(/.test(t);
const inComponent = (f: Finding) => f.file.startsWith('src/lib/components/');

// Pages keep zero tolerance — they got there and must stay. Components are
// ratcheted instead: they were never scanned until today and carry a hundred and
// nineteen strings, and a gate that fails on day one gets switched off rather
// than fixed. The number only goes down.
const componentFindings = findings.filter(inComponent);
const pageFindings = findings.filter((f) => !inComponent(f));
const scriptFindings = pageFindings.filter((f) => isScript(f.text));
const markupFindings = pageFindings.filter((f) => !isScript(f.text));

let baseline = 0;
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf-8')).count ?? 0;
} catch {
  baseline = 0;
}

let componentBaseline = 0;
try {
  componentBaseline = JSON.parse(readFileSync(COMPONENT_BASELINE, 'utf-8')).count ?? 0;
} catch {
  componentBaseline = 0;
}

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ count: scriptFindings.length }, null, 2)}\n`);
  writeFileSync(
    COMPONENT_BASELINE,
    `${JSON.stringify({ count: componentFindings.length }, null, 2)}\n`,
  );
  console.log(
    `[i18n-core] baselines updated: ${scriptFindings.length} script, ` +
      `${componentFindings.length} component string(s).`,
  );
  process.exit(0);
}

if (componentFindings.length > componentBaseline) {
  console.error(
    `❌ i18n-core: ${componentFindings.length} hardcoded string(s) in shared components — ` +
      `baseline allows ${componentBaseline}.\n`,
  );
  for (const f of componentFindings.slice(0, 15)) {
    console.error(`  ${f.file}:${f.line}\n      ${f.text}`);
  }
  console.error('\nTranslate one, or run --update after lowering the count.');
  process.exit(1);
}
if (componentFindings.length < componentBaseline) {
  console.log(
    `[i18n-core] component strings: ${componentFindings.length} ` +
      `(baseline ${componentBaseline}) — run --update to lock it in.`,
  );
}

if (scriptFindings.length > baseline) {
  console.error(
    `❌ i18n-core: ${scriptFindings.length} hardcoded string(s) in <script> — baseline allows ${baseline}.\n`,
  );
  for (const f of scriptFindings.slice(0, 20)) {
    console.error(`  ${f.file}:${f.line}\n      ${f.text}`);
  }
  console.error('\nTranslate one, or run --update after lowering the count.');
  process.exit(1);
}
if (scriptFindings.length < baseline) {
  console.log(
    `[i18n-core] script strings: ${scriptFindings.length} (baseline ${baseline}) — run --update to lock it in.`,
  );
}

if (markupFindings.length === 0) {
  console.log(
    `✅ i18n-core: every message key resolves; ` +
      `${SCANNED.length} page(s) and component(s) free of hardcoded markup` +
      (scriptFindings.length + componentFindings.length > 0
        ? `; ${scriptFindings.length} in <script>, ` +
          `${componentFindings.length} in shared components (both under a baseline).`
        : ', and none in <script> or in a shared component either.'),
  );
  process.exit(0);
}

console.error(`❌ i18n-core: ${markupFindings.length} hardcoded string(s) on translated pages.\n`);
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
