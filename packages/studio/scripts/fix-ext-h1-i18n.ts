#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const EXT_ROOT = join(import.meta.dir, '../../../../zveltio-extensions');

function findExtensions(base: string, prefix = ''): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (existsSync(join(base, entry.name, 'manifest.json'))) names.push(rel);
    else names.push(...findExtensions(join(base, entry.name), rel));
  }
  return names;
}

let fixed = 0;
for (const extName of findExtensions(EXT_ROOT)) {
  const pagePath = join(EXT_ROOT, extName, 'studio', 'pages', '+page.svelte');
  if (!existsSync(pagePath)) continue;
  const key = extName.replace(/\//g, '.');
  let c = readFileSync(pagePath, 'utf8');
  const before = c;
  c = c.replace(
    /<h1 class="text-xl font-semibold flex items-center gap-2">(<[^>]+\/>)\s*[^<{][^<]*<\/h1>/g,
    `<h1 class="text-xl font-semibold flex items-center gap-2">$1 {m['${key}.title']()}</h1>`,
  );
  if (c !== before) {
    writeFileSync(pagePath, c);
    fixed++;
  }
}
console.log(`[fix-h1] ${fixed} pages updated`);
