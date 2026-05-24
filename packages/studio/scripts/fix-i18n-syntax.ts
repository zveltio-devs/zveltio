#!/usr/bin/env bun
/** Fix placeholder="{m[...]()}" → placeholder={m[...]()} and ensure m import where used. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const EXT_ROOT = join(import.meta.dir, '../../../../zveltio-extensions');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.svelte')) out.push(p);
  }
  return out;
}

let fixed = 0;
function walkAll(): string[] {
  const pages = walk(join(EXT_ROOT));
  const extra: string[] = [];
  for (const ext of readdirSync(EXT_ROOT, { withFileTypes: true })) {
    if (!ext.isDirectory()) continue;
    const comp = join(EXT_ROOT, ext.name, 'studio', 'src');
    if (existsSync(comp)) extra.push(...walk(comp));
  }
  return [...pages, ...extra];
}

for (const p of walkAll()) {
  let c = readFileSync(p, 'utf8');
  const o = c;
  c = c.replace(/placeholder="\{m\[([^\]]+)\]\(\)\}"/g, 'placeholder={m[$1]()}');
  c = c.replace(/title="\{m\[([^\]]+)\]\(\)\}"/g, 'title={m[$1]()}');
  if (c.includes("m['") || c.includes('m["') || c.includes('m[')) {
    if (!c.includes("from '$lib/i18n")) {
      c = c.replace(/<script lang="ts">\n/, "<script lang=\"ts\">\n  import { m } from '$lib/i18n.svelte.js';\n");
    }
  }
  if (c !== o) {
    writeFileSync(p, c);
    fixed++;
  }
}
console.log(`[fix-i18n-syntax] ${fixed} files fixed`);
