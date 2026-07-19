#!/usr/bin/env bun
/** Repair common wrap-extension-shell mistakes (orphan </div>, buttons in children, duplicate h1). */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT = join(STUDIO, '..', '..', '..', 'zveltio-extensions');

function walk(dir: string, out: string[] = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === '+page.svelte') out.push(p);
  }
  return out;
}

function fixFile(path: string) {
  let c = readFileSync(path, 'utf8');
  if (!c.includes('<ExtensionPageShell')) return false;
  const o = c;

  // Orphan </div> after button at start of children
  c = c.replace(
    /(\{#snippet children\(\)\}\n)(<button[\s\S]*?<\/button>)\n\s*<\/div>\n\n/g,
    '$1$2\n\n',
  );

  // Move leading primary button from children into actions (if actions empty/missing)
  const shellMatch = c.match(
    /<ExtensionPageShell([^>]*)>([\s\S]*?)\{#snippet children\(\)\}\n(<button class="btn btn-primary[\s\S]*?<\/button>)\n\n([\s\S]*?)\n\s*\{\/snippet\}\n<\/ExtensionPageShell>/,
  );
  if (shellMatch && !shellMatch[2].includes('{#snippet actions()}')) {
    const attrs = shellMatch[1];
    const btn = shellMatch[3];
    const body = shellMatch[4];
    c = c.replace(
      shellMatch[0],
      `<ExtensionPageShell${attrs}>
  {#snippet actions()}
    ${btn}
  {/snippet}

  {#snippet children()}
${body}
  {/snippet}
</ExtensionPageShell>`,
    );
  }

  // Conditional action button at children start (subscriptions, procurement, api-connector)
  const condMatch = c.match(
    /<ExtensionPageShell([^>]*)>([\s\S]*?)\{#snippet children\(\)\}\n(\{#if[^}]+\}[\s\S]*?<button class="btn btn-primary[\s\S]*?<\/button>[\s\S]*?\{\/if\})\n\s*<\/div>\n\n/g,
  );
  if (condMatch) {
    c = c.replace(
      /<ExtensionPageShell([^>]*)>([\s\S]*?)\{#snippet children\(\)\}\n(\{#if[^}]+\}[\s\S]*?<button class="btn btn-primary[\s\S]*?<\/button>[\s\S]*?\{\/if\})\n\s*<\/div>\n\n/g,
      (full, attrs, mid, condBtn) => {
        if (mid.includes('{#snippet actions()}')) return full;
        return `<ExtensionPageShell${attrs}>${mid}  {#snippet actions()}
    ${condBtn.trim()}
  {/snippet}

  {#snippet children()}
`;
      },
    );
  }

  // Remove duplicate inline PageHeader inside children (shell already shows title)
  c = c.replace(
    /\n<div>\s*\n\s*<h1 class="text-xl font-semibold[\s\S]*?<\/p>\s*\n\s*<\/div>\s*\n/g,
    '\n',
  );

  // Orphan </div> only (no button before)
  c = c.replace(/\{#snippet children\(\)\}\n\s*<\/div>\n\n/g, '{#snippet children()}\n');

  if (c !== o) {
    writeFileSync(path, c);
    return true;
  }
  return false;
}

let n = 0;
for (const p of walk(EXT)) {
  if (fixFile(p)) {
    console.log('fixed', p.replace(EXT + '/', '').replace(/\\/g, '/'));
    n++;
  }
}
console.log(`fix-shell-wrap: ${n} file(s)`);
