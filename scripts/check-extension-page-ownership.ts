#!/usr/bin/env bun
/**
 * Gate: an extension's Studio page belongs to the extension.
 *
 * `docs/site/EXTENSION-DEVELOPER-GUIDE.md` § 10 says how to ship a Studio UI — a
 * declarative schema, or a code page under `studio/pages/` — and both live in
 * the extension. Nothing checked that, so pages drifted into the engine and
 * stayed there.
 *
 * Found by looking: `/introspect` was a 223-line page in the engine's Studio for
 * the BYOD extension, with a `/byod` route redirecting to it, while the
 * extension shipped its own page that called routes which do not exist. Two
 * implementations, one reachable, neither owned by the party responsible for it.
 *
 * WHY THIS IS NOT SIMPLY "NO EXTENSION CODE IN THE ENGINE"
 *
 * Most of what looks like extension UI in `packages/studio/src/routes/(admin)`
 * is a SNAPSHOT: `scripts/sync-extensions.ts` copies each extension's page into
 * the route tree, and the result is committed so a release build — which has no
 * `zveltio-extensions` sibling — still ships a working admin. That copy is
 * generated, deliberate, and correct.
 *
 * So the rule is not "no page here". It is:
 *
 *   a page in the engine that talks to `/ext/*` must be byte-identical to the
 *   extension page it was generated from, and that extension must declare it.
 *
 * Anything else is one of three problems, and the message says which:
 *
 *   ORPHAN     — no extension source. Somebody wrote an extension's UI here.
 *   STALE      — a source exists and has moved on. The snapshot needs syncing;
 *                until then the engine ships an older screen than the extension
 *                does, which is how `media` ended up rendering i18n keys
 *                belonging to `storage/cloud` and `communications/mail`.
 *   SHADOWS    — the extension ships a declarative SCHEMA for this path and a
 *                code page sits on top of it. The schema never renders, and
 *                whoever maintains it has no way to tell.
 *
 * Usage: bun scripts/check-extension-page-ownership.ts [extensions-root]
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const EXT_ROOT = process.argv[2] ?? join(ROOT, '..', 'zveltio-extensions');
const ADMIN = join(ROOT, 'packages/studio/src/routes/(admin)');

/** Every `+page.svelte` under the admin route tree. */
function adminPages(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) adminPages(p, acc);
    else if (entry === '+page.svelte') acc.push(p);
  }
  return acc;
}

/** Every manifest, at whatever depth — `compliance/ro/*` sits one level deeper. */
function manifests(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) manifests(p, acc);
    else if (entry === 'manifest.json') acc.push(p);
  }
  return acc;
}

interface Declared {
  ext: string;
  dir: string;
  /** Set when the extension ships a declarative schema for this path. */
  schema?: string;
}

const declared = new Map<string, Declared>();
for (const mf of manifests(EXT_ROOT)) {
  let manifest: {
    name?: string;
    studio?: { pages?: Array<{ path?: string; schema?: string }> };
  };
  try {
    manifest = JSON.parse(readFileSync(mf, 'utf8'));
  } catch {
    continue; // unreadable manifests are check-extension-authorization's problem
  }
  for (const page of manifest.studio?.pages ?? []) {
    const path = page.path ?? '';
    if (!path.startsWith('/admin/')) continue;
    declared.set(path.slice('/admin/'.length), {
      ext: manifest.name ?? relative(EXT_ROOT, dirname(mf)),
      dir: dirname(mf),
      schema: page.schema,
    });
  }
}

const problems: string[] = [];
let snapshots = 0;

for (const file of adminPages(ADMIN)) {
  const body = readFileSync(file, 'utf8');
  // Only pages that actually call an extension. A core page is free to exist.
  if (!/['"`]\/ext\//.test(body)) continue;

  const route = relative(ADMIN, dirname(file));

  // Platform home may probe optional extension APIs (e.g. CRM briefing) without
  // being an extension snapshot. Those pages stay owned by Studio core.
  if (route === '.' || route === '') continue;

  // An extension may declare ONE page and ship a tree beneath it — traceability
  // declares `/admin/traceability` and carries seven pages under it. So fall
  // back to the longest declared path this route sits under, and remember what
  // is left over so the source file can be found.
  let d = declared.get(route);
  let subPath = '';
  if (!d) {
    let best = '';
    for (const key of declared.keys()) {
      if (route === key || route.startsWith(`${key}/`)) {
        if (key.length > best.length) best = key;
      }
    }
    if (best) {
      d = declared.get(best);
      subPath = route.slice(best.length).replace(/^\//, '');
    }
  }

  if (!d) {
    problems.push(
      `ORPHAN   ${route}\n` +
        `           talks to /ext/* but no extension declares a page at /admin/${route}.\n` +
        `           Move it to that extension's studio/pages/ and declare it in its manifest.`,
    );
    continue;
  }

  if (d.schema) {
    // Schema owns the declared path itself. Nested routes under that path may
    // still be code pages (forms list is declarative; forms/[id] is the builder).
    if (!subPath) {
      problems.push(
        `SHADOWS  ${route}\n` +
          `           ${d.ext} ships a declarative schema (${d.schema}) for this path, and this\n` +
          `           code page renders instead. Delete this page and let the schema render.`,
      );
      continue;
    }
    // Fall through: compare nested code page to extension studio/pages/<subPath>.
  }

  const candidate = join(d.dir, 'studio', 'pages', subPath, '+page.svelte');

  if (!existsSync(candidate)) {
    problems.push(
      `ORPHAN   ${route}\n` + `           ${d.ext} declares this path but ships no page for it.`,
    );
    continue;
  }

  if (readFileSync(candidate, 'utf8') !== body) {
    problems.push(
      `STALE    ${route}\n` +
        `           differs from ${relative(EXT_ROOT, candidate)}.\n` +
        `           Run: cd packages/studio && EXTENSIONS_DIR=… bun scripts/sync-extensions.ts`,
    );
    continue;
  }

  snapshots++;
}

if (problems.length > 0) {
  console.error(
    `\n❌ extension-page-ownership: ${problems.length} page(s) in the engine are not a faithful snapshot.\n`,
  );
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(
    '  An extension owns its Studio page — see docs/site/EXTENSION-DEVELOPER-GUIDE.md § 10.\n' +
      '  The engine may carry a GENERATED copy so releases work without the extensions\n' +
      '  repository, and that copy must match what it was generated from.\n',
  );
  process.exit(1);
}

console.log(
  `✅ extension-page-ownership: ${snapshots} extension page(s) in the engine, all faithful snapshots.`,
);
