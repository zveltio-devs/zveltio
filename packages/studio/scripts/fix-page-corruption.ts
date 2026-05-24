#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
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

let n = 0;
for (const ext of walk(EXT_ROOT)) {
  const p = join(EXT_ROOT, ext, 'studio', 'pages', '+page.svelte');
  if (!existsSync(p)) continue;
  let c = readFileSync(p, 'utf8');
  const orig = c;
  c = c.replace(/\n\/?div>\n\n(\{#if show)/g, '\n\n$1');
  // Remove duplicated modal blocks (second identical {#if showPlanForm}...{/if})
  c = c.replace(/(\{#if show\w+\}[\s\S]*?\{\/if\})\s*\n\/?div>\s*\n\1/g, '$1');
  if (c !== orig) {
    writeFileSync(p, c);
    n++;
  }
}
console.log(`[fix-corruption] ${n} files cleaned`);
