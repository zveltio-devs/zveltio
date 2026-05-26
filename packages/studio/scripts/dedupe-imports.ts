#!/usr/bin/env bun
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const EXT = join(import.meta.dir, '..', '../../../zveltio-extensions');

function walk(d: string, o: string[] = []): string[] {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, o);
    else if (e.name === '+page.svelte') o.push(p);
  }
  return o;
}

let n = 0;
for (const p of walk(EXT)) {
  const lines = readFileSync(p, 'utf8').split('\n');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (
      t.startsWith('import ') &&
      (t.includes('ConfirmModal') || t.includes('createExtensionConfirm'))
    ) {
      if (seen.has(t)) continue;
      seen.add(t);
    }
    out.push(line);
  }
  const next = out.join('\n');
  if (next !== readFileSync(p, 'utf8')) {
    writeFileSync(p, next);
    n++;
  }
}
console.log(`deduped ${n} files`);
