#!/usr/bin/env bun
/** Restore extension pages from Studio routes when Studio copy is structurally sound. */
import { existsSync, readdirSync, readFileSync, writeFileSync, cpSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT_ROOT = join(STUDIO, '../../../zveltio-extensions');
const ROUTES = join(STUDIO, 'src/routes/(admin)');

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

function isBroken(content: string): boolean {
  if (!content.includes('<ExtensionPageShell')) return false;
  if (/\{#snippet children\(\)\}\s*\n\s*\{:else/.test(content)) return true;
  if (/\{#snippet children\(\)\}\s*\n\s*<\/aside>/.test(content)) return true;
  if (/\{#snippet children\(\)\}[\s\S]{0,200}\{#if showShareDialog/.test(content)) return true;
  return false;
}

let restored = 0;
let skipped = 0;

for (const extName of findExtensions(EXT_ROOT)) {
  const manifestPath = join(EXT_ROOT, extName, 'manifest.json');
  const pagePath = join(EXT_ROOT, extName, 'studio', 'pages', '+page.svelte');
  if (!existsSync(pagePath)) continue;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    studio?: { pages?: Array<{ path: string }> };
  };
  const firstPage = manifest.studio?.pages?.[0];
  const slug = firstPage?.path
    ? firstPage.path.replace(/^\/admin\//, '').replace(/^\//, '')
    : extName;
  const studioPage = join(ROUTES, slug, '+page.svelte');
  if (!existsSync(studioPage)) {
    skipped++;
    continue;
  }

  const extContent = readFileSync(pagePath, 'utf8');
  const studioContent = readFileSync(studioPage, 'utf8');

  if (!isBroken(extContent)) continue;
  if (isBroken(studioContent)) {
    console.warn(`[restore] both broken: ${extName}`);
    continue;
  }

  cpSync(studioPage, pagePath);
  restored++;
}

console.log(`[restore] restored ${restored} pages from Studio (skipped ${skipped} no route)`);
