#!/usr/bin/env bun
/**
 * Apply a central English→locale dictionary to every i18n source file.
 *
 * Sources of truth (NOT the generated messages/{locale}.json bundle):
 *   - packages/studio/messages/core/{locale}.json          (Studio shell)
 *   - zveltio-extensions/**\/studio/messages/{locale}.json  (per extension)
 *
 * For every English source (`en.json`) we walk its keys and, for each locale,
 * write value = dictionary[englishValue][locale] when present, else keep the
 * existing locale value if it already differs from English (don't clobber a
 * prior good translation), else fall back to English. Keys are kept in the
 * same order as the English file so diffs stay readable.
 *
 * The dictionary lives in scripts/i18n-dictionary.json as:
 *   { "<english string>": { ro, fr, de, es, it, nl, pl, hu } }
 * A locale may be omitted for a term that is identical to English (URLs,
 * proper nouns, protocol names) — we then keep the English string.
 *
 * Idempotent: safe to run repeatedly. Run `bun run i18n:compile` afterwards.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const STUDIO = join(import.meta.dir, '..');
const EXT_ROOT = join(STUDIO, '../../../zveltio-extensions');
const LOCALES = ['ro', 'fr', 'de', 'es', 'it', 'nl', 'pl', 'hu'] as const;
type Locale = (typeof LOCALES)[number];

const dict: Record<string, Partial<Record<Locale, string>>> = JSON.parse(
  readFileSync(join(import.meta.dir, 'i18n-dictionary.json'), 'utf8'),
);

function enFiles(): string[] {
  const out = [join(STUDIO, 'messages/core/en.json')];
  if (existsSync(EXT_ROOT)) {
    const found = execSync(`find . -path "*/studio/messages/en.json" -not -path "*/node_modules/*"`, {
      cwd: EXT_ROOT,
    })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((f) => join(EXT_ROOT, f.replace(/^\.\//, '')));
    out.push(...found);
  }
  return out;
}

let filesWritten = 0;
const missing = new Map<string, number>(); // english → count of locales still English

for (const enPath of enFiles()) {
  const en: Record<string, string> = JSON.parse(readFileSync(enPath, 'utf8'));
  for (const locale of LOCALES) {
    const locPath = enPath.replace(/en\.json$/, `${locale}.json`);
    const existing: Record<string, string> = existsSync(locPath)
      ? JSON.parse(readFileSync(locPath, 'utf8'))
      : {};
    const next: Record<string, string> = {};
    for (const [key, enVal] of Object.entries(en)) {
      const fromDict = dict[enVal]?.[locale];
      if (fromDict) {
        next[key] = fromDict;
      } else if (existing[key] && existing[key] !== enVal) {
        next[key] = existing[key]; // keep a prior human translation
      } else {
        next[key] = enVal; // fall back to English
        if (enVal.trim().length > 1) missing.set(enVal, (missing.get(enVal) ?? 0) + 1);
      }
    }
    writeFileSync(locPath, JSON.stringify(next, null, 2) + '\n');
    filesWritten++;
  }
}

console.log(`wrote ${filesWritten} locale files across ${enFiles().length} sources`);
console.log(`dictionary entries: ${Object.keys(dict).length}`);
const stillEnglish = [...missing.keys()];
console.log(`unique strings still falling back to English: ${stillEnglish.length}`);
if (process.argv.includes('--list-missing')) {
  writeFileSync(
    join(import.meta.dir, 'i18n-missing.json'),
    JSON.stringify(stillEnglish.sort((a, b) => a.localeCompare(b)), null, 0),
  );
  console.log('→ wrote scripts/i18n-missing.json');
}
