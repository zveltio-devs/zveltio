#!/usr/bin/env bun
/**
 * Merge core + per-extension studio/messages into messages/{locale}.json for Paraglide.
 *
 * Three modes, by what extension source is on disk:
 *
 *  1. Dev — `zveltio-extensions` sibling present: authoritative full regen from
 *     messages/core + every sibling extension. A key removed from an extension
 *     disappears from the bundle (dev is the source of truth).
 *
 *  2. Install-time rebuild — no sibling but `EXTENSIONS_DIR` present (studio-builder
 *     runs `bun run build` on the server at enable). The shipped
 *     messages/{locale}.json is ALREADY the full release bundle. Rewriting it from
 *     core-only would silently drop every extension's keys, so the compiled
 *     Paraglide loses functions like `compliance.ro.etransport.subtitle` and the
 *     page crashes with "… is not a function". Instead we OVERLAY the installed
 *     extensions' messages on top of the committed bundle — the result is never
 *     smaller than what shipped.
 *
 *  3. No extension source at all — release runner: leave the committed bundle
 *     untouched and let Paraglide compile it as-is.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { findExtensions, LOCALES, sortKeys, type Locale } from './lib/extension-i18n.ts';

const STUDIO = join(import.meta.dir, '..');
const DEV_SIBLING = join(STUDIO, '../../../zveltio-extensions');
const INSTALLED_DIR = process.env.EXTENSIONS_DIR ?? '';
const CORE_DIR = join(STUDIO, 'messages/core');
const OUT_DIR = join(STUDIO, 'messages');

const hasDevSibling = existsSync(DEV_SIBLING);
const hasInstalledDir = Boolean(INSTALLED_DIR) && existsSync(INSTALLED_DIR);

// Dev sibling wins as the authoritative source; otherwise merge from the
// installed extensions directory.
const EXT_ROOT = hasDevSibling ? DEV_SIBLING : INSTALLED_DIR;

function readJson(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

function loadBundle(locale: Locale): Record<string, string> {
  const merged: Record<string, string> = {};
  const enFallback = locale === 'en' ? {} : readJson(join(CORE_DIR, 'en.json'));

  const layers: Record<string, string>[] = [];

  // Install-time overlay: floor = the full committed bundle so we never shrink
  // below what shipped. No-op in dev (dev regen is authoritative).
  if (!hasDevSibling) {
    layers.push(readJson(join(OUT_DIR, `${locale}.json`)));
  }

  layers.push(readJson(join(CORE_DIR, `${locale}.json`)));
  for (const ext of findExtensions(EXT_ROOT)) {
    layers.push(readJson(join(EXT_ROOT, ext, 'studio', 'messages', `${locale}.json`)));
  }

  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (k === '$schema') continue;
      merged[k] = v;
    }
  }

  // Fill missing keys from English (fr/de bootstrap).
  if (locale !== 'en') {
    for (const [k, v] of Object.entries(enFallback)) {
      if (!(k in merged)) merged[k] = v;
    }
    for (const ext of findExtensions(EXT_ROOT)) {
      const enExt = readJson(join(EXT_ROOT, ext, 'studio', 'messages', 'en.json'));
      for (const [k, v] of Object.entries(enExt)) {
        if (!(k in merged)) merged[k] = v;
      }
    }
  }

  return sortKeys(merged);
}

// No extension source on disk → the committed messages/{locale}.json are already
// the full merged release bundle. Touching them would corrupt the Studio.
if (!hasDevSibling && !hasInstalledDir) {
  console.log('[i18n:merge] No extension source — keeping committed merged bundles untouched.');
  process.exit(0);
}

console.log(
  `[i18n:merge] source: ${hasDevSibling ? 'dev sibling (authoritative regen)' : `installed dir overlay (${INSTALLED_DIR})`}`,
);

mkdirSync(CORE_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const collisions: string[] = [];
for (const locale of LOCALES) {
  const merged = loadBundle(locale);
  writeFileSync(join(OUT_DIR, `${locale}.json`), JSON.stringify(merged, null, 2) + '\n');
  console.log(`[i18n:merge] ${locale}.json — ${Object.keys(merged).length} keys`);
}

// Collision check (same key, different values across layers — last wins; log duplicates at merge time)
for (const ext of findExtensions(EXT_ROOT)) {
  for (const locale of LOCALES) {
    const p = join(EXT_ROOT, ext, 'studio', 'messages', `${locale}.json`);
    if (!existsSync(p)) continue;
    const extKeys = Object.keys(readJson(p));
    const core = readJson(join(CORE_DIR, `${locale}.json`));
    for (const k of extKeys) {
      if (k in core && core[k] !== readJson(p)[k]) {
        collisions.push(`${locale}:${k} (core vs ${ext})`);
      }
    }
  }
}

if (collisions.length) {
  console.warn(
    `[i18n:merge] warning: ${collisions.length} core/extension key overlaps (extension wins in bundle)`,
  );
}

console.log('[i18n:merge] done');
