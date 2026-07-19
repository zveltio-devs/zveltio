#!/usr/bin/env bun
/** Scan extension pages for likely hardcoded UI strings not using m[ */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const EXT_ROOT = join(import.meta.dir, '../../../../zveltio-extensions');

function walk(base: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (existsSync(join(base, e.name, 'manifest.json'))) out.push(rel);
    else out.push(...walk(join(base, e.name), rel));
  }
  return out;
}

const patterns = [
  />\s*([A-Za-z][A-Za-z0-9 ,.'’()/\-–—]{2,60}?)\s*</g,
  /placeholder="([^"]{3,})"/g,
  /title="([^"]{3,})"/g,
  /toast\.success\('([^']+)'\)/g,
  /toast\.error\([^m][^)]*'([^']+)'\)/g,
  /<h[23][^>]*>([^<{][^<]{2,80})</g,
  /<option[^>]*>([^<{][^<]{2,40})</g,
  /<span class="label-text[^"]*">([^<{][^<]{2,50})</g,
];

const skip = new Set([
  'RON',
  'EUR',
  'USD',
  'POST',
  'GET',
  'PUT',
  'DELETE',
  'CSV',
  'JSON',
  'NDJSON',
  'SQL',
  'API',
  'AI',
  'ID',
  'OK',
  'Yes',
  'No',
]);

let total = 0;
for (const ext of walk(EXT_ROOT)) {
  const p = join(EXT_ROOT, ext, 'studio', 'pages', '+page.svelte');
  if (!existsSync(p)) continue;
  const c = readFileSync(p, 'utf8');
  if (c.includes("m['") && !c.match(/>\s*[A-Z][a-z]+/)) continue;
  const found = new Set<string>();
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    const src = c.replace(/\{m\[[^\]]+\]\(\)\}/g, '').replace(/\{[^}]+\}/g, '');
    while ((m = re.exec(src))) {
      const s = m[1].trim();
      if (s.length < 3 || /^\d+$/.test(s) || skip.has(s)) continue;
      if (s.includes('btn-') || s.includes('class=')) continue;
      found.add(s);
    }
  }
  if (found.size > 0) {
    console.log(`\n## ${ext} (${found.size})`);
    [...found].slice(0, 25).forEach((s) => console.log(' -', s));
    if (found.size > 25) console.log(` ... +${found.size - 25} more`);
    total += found.size;
  }
}
console.log(`\nTotal candidate strings: ${total}`);
