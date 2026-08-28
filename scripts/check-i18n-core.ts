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
  // The product's own name, and a command somebody types verbatim. Neither is
  // translated in any locale — a Hungarian operator still types `zveltio update`.
  'Zveltio',
  'zveltio update',
  // A key cap. `Esc` reads `Esc` on a Hungarian keyboard too.
  'Esc',
  // A product name and a file extension. Nobody localises either.
  'Excel (.xlsx)',
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
  // An HTTP header name shown in a code sample. `X-API-Key:` and
  // `X-Preview-Token:` are wire identifiers — a translated header does not
  // reach the server.
  /^X-[A-Za-z][A-Za-z0-9-]*:$/,
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

/**
 * Blank every `{...}` expression, keeping its newlines so line numbers survive.
 *
 * Runs BEFORE anything looks for tags, and that order is the whole point: an
 * expression may contain `>` — `{#if tabs.length > 0 && activeTab}` — and a
 * tag scan that meets that operator first reads the rest of the condition as a
 * text node. The first version of this check reported
 * `0 && activeTab && onTabChange` as untranslated prose.
 *
 * Braces are counted rather than matched with `\{[^}]*\}`, so a nested object
 * literal — `{Array.from({ length: rows })}` — does not end the blanking early
 * and leak `)}` into the markup.
 */
function blankExpressions(text: string): string {
  let out = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth--;
      continue;
    }
    if (depth > 0) {
      if (ch === '\n') out += ch;
      continue;
    }
    out += ch;
  }
  return out;
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

/**
 * A file that calls `m['key']()` must import `m`.
 *
 * The key check above proves the catalogue has the key. It says nothing about
 * whether `m` is in scope, and an unimported `m` is not a missing translation —
 * it is `ReferenceError: m is not defined`, thrown during render, which blanks
 * the component and everything below it. Svelte does not fail the build for it
 * and `tsc` does not see inside the template.
 *
 * Found by shipping it three times in one pass: `Pagination`, `UpdateBanner`
 * and `SnippetGenerator` each got a translated string and no import, and only
 * `Pagination` had a component test to notice.
 */
function checkMessageImports(): string[] {
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
      if (!/\bm\[['"]/.test(src)) continue;
      // Any import that binds `m`, not one blessed path: the wrapper
      // `$lib/i18n.svelte.js` is the usual source, but extension components
      // import the compiled runtime `$lib/paraglide/messages.js` directly and
      // are perfectly correct. A first version named only the wrapper and
      // reported `ReceivablesCard` — which imports the other one — as broken.
      if (/import\s*\{[^}]*\bm\b[^}]*\}\s*from/.test(src)) continue;
      broken.push(relative(STUDIO, p));
    }
  };
  walk(join(STUDIO, 'src'));
  return broken;
}

const missingImports = checkMessageImports();
if (missingImports.length > 0) {
  console.error(
    `❌ i18n-core: ${missingImports.length} file(s) call m['...'] without importing m.\n`,
  );
  for (const f of missingImports) console.error(`  ${f}`);
  console.error(
    '\nThat is not a missing translation — it throws `m is not defined` at render\n' +
      "and blanks the component. Add:  import { m } from '$lib/i18n.svelte.js';\n",
  );
  process.exit(1);
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
      // `.test.svelte` is a fixture a test mounts, not a screen anybody reads.
      else if (e.name.endsWith('.svelte') && !e.name.endsWith('.test.svelte')) {
        out.push(relative(STUDIO, full));
      }
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

  // Blank the <script>, <style> and comment blocks rather than deleting them:
  // only markup is user-visible text, but removing the lines shifts every number
  // after it and a gate that points at the wrong line is worse than no line at
  // all.
  const blank = (block: string) => '\n'.repeat((block.match(/\n/g) ?? []).length);
  const markup = src
    .replace(/<script[\s\S]*?<\/script>/g, blank)
    .replace(/<style[\s\S]*?<\/style>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);

  // Text nodes, ACROSS lines.
  //
  // This was `/>([^<>{}\n]+)</` applied line by line, which required the opening
  // `>`, the text and the closing `<` to sit on ONE line with no braces between
  // them. Svelte is not written that way — a formatter puts the text on its own
  // line — so the ordinary shape was never looked at:
  //
  //     <h3 class="...">
  //       Active Inheritance Rules ({hierarchy.length})
  //     </h3>
  //
  // The gate reported that file clean with that heading in it, and reported the
  // whole Studio at zero while twenty-six such strings were on screen. Two
  // exclusions had to miss at once, and both did: the newline and the
  // interpolation. It is the fifth blind spot found in this one gate.
  //
  // So: take every span between `>` and the next `<` whatever it contains, then
  // remove the Svelte expressions with BALANCED braces — `{#if}`, `{:else}` and
  // `{@const}` fall out with them, and a nested `{ length: n }` does not end the
  // strip early the way `\{[^}]*\}` would. What survives is the literal text.
  const proseOnly = blankExpressions(markup);
  for (const m of proseOnly.matchAll(/>([^<>]*)</g)) {
    const raw = m[1]!;
    const literal = raw.replace(/\s+/g, ' ').trim();
    if (!looksTranslatable(literal)) continue;
    // Point at the TEXT, not at the `>` that opened it. On a multi-line node
    // those are different lines, and a gate that names the tag line sends the
    // reader — or a script — to the wrong place.
    const lead = raw.length - raw.trimStart().length;
    findings.push({
      file: rel,
      line: proseOnly.slice(0, m.index! + 1 + lead).split('\n').length,
      text: literal,
    });
  }

  markup.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/(placeholder|title|aria-label|alt)="([^"]+)"/g)) {
      // An attribute whose value is nothing but expressions and punctuation —
      // `aria-label="{label}: {value}"` — has no words of its own. They live in
      // whatever those expressions resolve to, and flagging the attribute points
      // at the wrong file.
      const literal = m[2]!.replace(/\{[^}]*\}/g, '').trim();
      if (!literal || !/[a-zA-Z]{2}/.test(literal)) continue;
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
    // A line of comment is documentation, not a screen. The example in
    // `ToastContainer`'s own header — `toast.success('Saved!')` — is there to
    // show a caller how to use it, and asking for it to be translated is asking
    // the wrong thing of the wrong file.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
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

// `--list` prints every finding, machine-readably, and exits 0.
//
// The failure paths below cap their output at fifteen or twenty lines, which is
// right for a gate — a wall of text does not get read. It is wrong for doing the
// work: a translation pass needs the whole list, and the component ratchet stops
// the run before the page findings are ever printed.
if (process.argv.includes('--list')) {
  for (const f of findings) console.log(`${f.file}:${f.line}\t${f.text}`);
  console.error(`[i18n-core] ${findings.length} finding(s).`);
  process.exit(0);
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
