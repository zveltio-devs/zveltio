#!/usr/bin/env bun
/** Remove broken ExtensionPageShell wrappers (duplicate headers, truncated markup). */
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

function unwrap(content: string): string {
  if (!content.includes('<ExtensionPageShell')) return content;

  const shellMatch = content.match(
    /<ExtensionPageShell[\s\S]*?\{#snippet actions\(\)\}([\s\S]*?)\{\/snippet\}[\s\S]*?\{#snippet children\(\)\}\s*([\s\S]*?)\s*\{\/snippet\}\s*<\/ExtensionPageShell>/,
  );
  const shellMatch2 = content.match(
    /<ExtensionPageShell[\s\S]*?\{#snippet children\(\)\}\s*([\s\S]*?)\s*\{\/snippet\}\s*<\/ExtensionPageShell>/,
  );

  const match = shellMatch ?? shellMatch2;
  if (!match) {
    // Catastrophic break — drop shell tags only
    return content
      .replace(/import ExtensionPageShell[^\n]+\n/g, '')
      .replace(/import ExtensionDataPanel[^\n]+\n/g, '')
      .replace(/<ExtensionPageShell[\s\S]*?<\/ExtensionPageShell>\s*/g, '');
  }

  let actions = '';
  let inner = match[match.length - 1];
  if (shellMatch && match[1] && match[1].includes('btn')) {
    actions = match[1].trim();
  }

  inner = inner
    .replace(/^<div class="flex items-center justify-between">[\s\S]*?<\/div>\s*<\/div>\s*/m, '')
    .replace(/^<header class="flex items-center justify-between">[\s\S]*?<\/header>\s*/m, '')
    .replace(/^<div>\s*<h1[\s\S]*?<\/div>\s*/m, '')
    .trim();

  const afterShell = content.slice(
    content.indexOf('</ExtensionPageShell>') + '</ExtensionPageShell>'.length,
  );

  let headerActions = '';
  if (actions) {
    headerActions = `\n  <div class="flex justify-end">${actions}</div>\n`;
  }

  const scriptEnd = content.indexOf('</script>') + '</script>'.length;
  const script = content.slice(0, scriptEnd);
  let cleanedScript = script
    .replace(/import ExtensionPageShell[^\n]+\n/g, '')
    .replace(/import ExtensionDataPanel[^\n]+\n/g, '')
    .replace(/import ConfirmModal[^\n]+\n/g, '');

  return `${cleanedScript}\n\n<div class="space-y-4">${headerActions}\n${inner}\n</div>${afterShell}`;
}

let n = 0;
for (const ext of findExtensions(EXT_ROOT)) {
  const p = join(EXT_ROOT, ext, 'studio', 'pages', '+page.svelte');
  if (!existsSync(p)) continue;
  const c = readFileSync(p, 'utf8');
  if (!c.includes('<ExtensionPageShell')) continue;
  // Keep proper shells (ExtensionDataPanel inside children)
  if (/\{#snippet children\(\)\}\s*\n\s*<ExtensionDataPanel/.test(c)) continue;
  if (/\{#snippet children\(\)\}\s*\n\s*\{#if stats/.test(c)) continue;

  const next = unwrap(c);
  if (next !== c) {
    writeFileSync(p, next);
    n++;
  }
}
console.log(`[strip-shell] unwrapped ${n} broken pages`);
