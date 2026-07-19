#!/usr/bin/env bun
/**
 * Safely wrap extension pages in ExtensionPageShell (manual pattern — no auto-truncate).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT = join(STUDIO, '..', '..', '..', 'zveltio-extensions');
const EN = join(STUDIO, 'messages/en.json');

const en = JSON.parse(readFileSync(EN, 'utf8')) as Record<string, string>;

const SKIP = new Set([
  'ai',
  'developer/edge-functions',
  'developer/validation',
  'communications/mail',
  'search',
  'crm',
  'hr/leave',
  'hr/employees',
  'finance/invoicing',
  'finance/expenses',
  'operations/inventory',
  'finance/banking',
]);

function pathToPrefix(rel: string): string {
  return rel.replace(/\/studio\/pages\/\+page\.svelte$/, '').replace(/\//g, '.');
}

function walkPages(dir: string, out: string[] = []): string[] {
  const p = join(dir, 'studio', 'pages', '+page.svelte');
  if (existsSync(p)) out.push(p);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.')) walkPages(join(dir, e.name), out);
  }
  return out;
}

function extractSpaceY4(template: string): { inner: string; after: string } | null {
  const start = template.indexOf('<div class="space-y-4">');
  if (start < 0) return null;
  let depth = 0;
  let i = start;
  while (i < template.length) {
    if (template.startsWith('<div', i)) depth++;
    else if (template.startsWith('</div>', i)) {
      depth--;
      if (depth === 0) {
        const inner = template.slice(start + '<div class="space-y-4">'.length, i);
        return { inner, after: template.slice(i + '</div>'.length) };
      }
    }
    i++;
  }
  return null;
}

function peelHeader(inner: string): { actions: string; body: string } {
  let s = inner.trimStart();
  const between =
    /^<div class="flex items-center justify-between[^>]*>([\s\S]*?)<\/div>\s*\n?/m.exec(s);
  if (between) {
    const block = between[1];
    const btnMatch = block.match(
      /(<(?:div class="flex gap-2"[^>]*>)?[\s\S]*?<button[\s\S]*?<\/button>[\s\S]*?(?:<\/div>)?)\s*$/m,
    );
    const actions = btnMatch ? btnMatch[1].trim() : '';
    s = s.slice(between[0].length);
    return { actions, body: s };
  }
  const endOnly = /^<div class="flex justify-end[^>]*>([\s\S]*?)<\/div>\s*\n?/m.exec(s);
  if (endOnly) {
    return { actions: endOnly[1].trim(), body: s.slice(endOnly[0].length) };
  }
  return { actions: '', body: s };
}

function ensureShellImport(src: string): string {
  if (src.includes('ExtensionPageShell')) return src;
  return src.replace(
    /<script lang="ts">\n/,
    `<script lang="ts">\n  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';\n`,
  );
}

let wrapped = 0;
for (const abs of walkPages(EXT)) {
  const rel = abs.slice(EXT.length + 1).replace(/\\/g, '/');
  const extPath = rel.replace(/\/studio\/pages\/\+page\.svelte$/, '');
  if (SKIP.has(extPath)) continue;

  let src = readFileSync(abs, 'utf8');
  if (src.includes('<ExtensionPageShell')) continue;

  const prefix = pathToPrefix(rel);
  const titleKey = `${prefix}.title`;
  const subtitleKey = `${prefix}.subtitle`;
  if (!en[titleKey]) continue;

  const scriptEnd = src.indexOf('</script>');
  if (scriptEnd < 0) continue;
  const template = src.slice(scriptEnd + '</script>'.length).trimStart();
  const extracted = extractSpaceY4(template);
  if (!extracted) continue;

  const { actions, body } = peelHeader(extracted.inner);
  const subtitleExpr = en[subtitleKey] ? ` subtitle={m['${subtitleKey}']()}` : '';

  const actionsBlock = actions ? `  {#snippet actions()}\n    ${actions}\n  {/snippet}\n\n` : '';

  const newTemplate = `<ExtensionPageShell title={m['${titleKey}']()}${subtitleExpr}>
${actionsBlock}  {#snippet children()}
${body.trim()}
  {/snippet}
</ExtensionPageShell>${extracted.after}`;

  src = ensureShellImport(src.slice(0, scriptEnd + '</script>'.length)) + '\n\n' + newTemplate;
  writeFileSync(abs, src);
  wrapped++;
  console.log('wrapped', extPath);
}

console.log(`wrap-extension-shell: ${wrapped} page(s)`);
