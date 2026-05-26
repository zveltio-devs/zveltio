#!/usr/bin/env bun
/**
 * Merge core + per-extension studio/messages into messages/{locale}.json for Paraglide.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { findExtensions, LOCALES, sortKeys, type Locale } from './lib/extension-i18n.ts';

const STUDIO = join(import.meta.dir, '..');
const EXT_ROOT = join(STUDIO, '../../../zveltio-extensions');
const CORE_DIR = join(STUDIO, 'messages/core');
const OUT_DIR = join(STUDIO, 'messages');

function readJson(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

function loadBundle(locale: Locale): Record<string, string> {
  const merged: Record<string, string> = {};
  const enFallback = locale === 'en' ? {} : readJson(join(CORE_DIR, 'en.json'));

  const layers: Record<string, string>[] = [
    readJson(join(CORE_DIR, `${locale}.json`)),
    ...findExtensions(EXT_ROOT).map((ext) =>
      readJson(join(EXT_ROOT, ext, 'studio', 'messages', `${locale}.json`)),
    ),
  ];

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
