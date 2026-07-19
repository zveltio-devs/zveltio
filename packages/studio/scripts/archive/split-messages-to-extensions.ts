#!/usr/bin/env bun
/**
 * One-time / maintenance: split messages/{locale}.json into messages/core + extension studio/messages.
 * Creates fr.json and de.json (from en) where missing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  findExtensions,
  LOCALES,
  ownerForKey,
  sortKeys,
  type Locale,
} from './lib/extension-i18n.ts';

const STUDIO = join(import.meta.dir, '..');
const EXT_ROOT = join(STUDIO, '../../../zveltio-extensions');
const MSG_DIR = join(STUDIO, 'messages');
const CORE_DIR = join(MSG_DIR, 'core');

const CORE_FR: Record<string, string> = {
  'shell.language': 'Langue',
  'shell.localeEn': 'Anglais',
  'shell.localeRo': 'Roumain',
  'shell.localeFr': 'Français',
  'shell.localeDe': 'Allemand',
  'shell.search': 'Rechercher…',
};

const CORE_DE: Record<string, string> = {
  'shell.language': 'Sprache',
  'shell.localeEn': 'Englisch',
  'shell.localeRo': 'Rumänisch',
  'shell.localeFr': 'Französisch',
  'shell.localeDe': 'Deutsch',
  'shell.search': 'Suchen…',
};

function readMessages(locale: Locale): Record<string, string> {
  const p = join(MSG_DIR, `${locale}.json`);
  if (!existsSync(p)) return {};
  const data = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
  delete data.$schema;
  return data;
}

const extensions = findExtensions(EXT_ROOT);
const buckets = new Map<string, Record<Locale, Record<string, string>>>();
buckets.set('core', { en: {}, ro: {}, fr: {}, de: {} });
for (const ext of extensions) {
  buckets.set(ext, { en: {}, ro: {}, fr: {}, de: {} });
}

for (const locale of ['en', 'ro'] as const) {
  const all = readMessages(locale);
  for (const [key, value] of Object.entries(all)) {
    const owner = ownerForKey(key, extensions);
    buckets.get(owner)![locale][key] = value;
  }
}

// Bootstrap fr/de from en (+ ro where we only have ro), apply core UI labels
const enAll = readMessages('en');
for (const locale of ['fr', 'de'] as const) {
  const existing = readMessages(locale);
  const coreExtras = locale === 'fr' ? CORE_FR : CORE_DE;
  for (const [key, value] of Object.entries(enAll)) {
    const owner = ownerForKey(key, extensions);
    const translated = existing[key] ?? coreExtras[key] ?? value;
    buckets.get(owner)![locale][key] = translated;
  }
}

// Add locale labels to core en/ro too
for (const [k, v] of Object.entries({
  'shell.localeFr': 'Français',
  'shell.localeDe': 'Deutsch',
})) {
  buckets.get('core')!.en[k] = buckets.get('core')!.en[k] ?? v;
  buckets.get('core')!.ro[k] =
    buckets.get('core')!.ro[k] ?? (k === 'shell.localeFr' ? 'Franceză' : 'Germană');
  buckets.get('core')!.fr[k] = CORE_FR[k]!;
  buckets.get('core')!.de[k] = CORE_DE[k]!;
}

mkdirSync(CORE_DIR, { recursive: true });

for (const [owner, locales] of buckets) {
  for (const locale of LOCALES) {
    const data = sortKeys(locales[locale]);
    if (Object.keys(data).length === 0) continue;
    const out =
      owner === 'core'
        ? join(CORE_DIR, `${locale}.json`)
        : join(EXT_ROOT, owner, 'studio', 'messages', `${locale}.json`);
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
  }
  if (owner !== 'core') {
    const counts = LOCALES.map((l) => Object.keys(locales[l]).length).join('/');
    console.log(`${owner} → ${counts} keys (en/ro/fr/de)`);
  }
}

const coreCounts = LOCALES.map((l) => Object.keys(buckets.get('core')![l]).length).join('/');
console.log(`core → ${coreCounts} keys`);
console.log('[split-messages] done — run: bun run i18n:merge && bun run i18n:compile');
