#!/usr/bin/env bun
/**
 * Batch: navGroup on manifests, generate ext message keys, baseline i18n on extension pages.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STUDIO_ROOT = join(import.meta.dir, '..');
const EXT_ROOT = join(STUDIO_ROOT, '../../../zveltio-extensions');
const EN_PATH = join(STUDIO_ROOT, 'messages/en.json');
const RO_PATH = join(STUDIO_ROOT, 'messages/ro.json');

const CATEGORY_NAV: Record<string, string> = {
  business: 'business',
  finance: 'finance',
  hr: 'hr',
  operations: 'operations',
  compliance: 'compliance',
  'compliance/ro': 'compliance',
  content: 'content',
  communications: 'communications',
  projects: 'projects',
  developer: 'developer',
  analytics: 'developer',
  auth: 'other',
  geospatial: 'developer',
  integrations: 'developer',
  workflow: 'other',
  billing: 'finance',
  ecommerce: 'business',
  data: 'developer',
  storage: 'other',
  search: 'developer',
  sms: 'communications',
  intelligence: 'developer',
  ai: 'developer',
  forms: 'content',
  i18n: 'other',
};

function msgKey(extName: string): string {
  return extName.replace(/\//g, '.');
}

function findExtensions(base: string, prefix = ''): string[] {
  const names: string[] = [];
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (existsSync(join(base, entry.name, 'manifest.json'))) names.push(rel);
    else names.push(...findExtensions(join(base, entry.name), rel));
  }
  return names;
}

function extractH1(html: string): { h1?: string; subtitle?: string } {
  const h1m = html.match(/<h1[^>]*>(?:<[^>]+>)*\s*([^<]+?)\s*(?:<\/[^>]+>)*<\/h1>/);
  const subm = html.match(/<p class="text-sm text-base-content\/50">([^<]+)<\/p>/);
  return {
    h1: h1m?.[1]?.trim(),
    subtitle: subm?.[1]?.trim(),
  };
}

function patchPage(content: string, key: string): string {
  if (!content.includes("from '$lib/i18n")) {
    content = content.replace(
      /<script lang="ts">\n/,
      "<script lang=\"ts\">\n  import { m } from '$lib/i18n.svelte.js';\n",
    );
  }

  const reps: [RegExp, string][] = [
    [/toast\.error\(e\?\.message \?\? 'Failed to load[^']*'\)/g, "toast.error(e instanceof Error ? e.message : m['ext.loadFailed']())"],
    [/toast\.error\(e\?\.message \?\? 'Error'\)/g, "toast.error(e instanceof Error ? e.message : m['ext.saveFailed']())"],
    [/toast\.error\(e\?\.message \?\? 'Failed[^']*'\)/g, "toast.error(e instanceof Error ? e.message : m['ext.loadFailed']())"],
    [/toast\.success\('([^']+)'\)/g, (_, msg) => {
      const map: Record<string, string> = {
        'Deleted.': "m['ext.deleted']()",
        'Approved.': "m['ext.approved']()",
        'Created.': "m['ext.created']()",
      };
      return `toast.success(${map[msg] ?? `'${msg}'`})`;
    }],
    [/>Cancel</g, '>{m[\'common.cancel\']()}<'],
    [/>\s*Create\s*</g, '>{m[\'common.create\']()}<'],
  ];
  for (const [re, sub] of reps) content = content.replace(re, sub);

  // Title / subtitle from messages when plain h1 present
  const title = `${key}.title`;
  const sub = `${key}.subtitle`;
  content = content.replace(
    /<h1 class="text-xl font-semibold[^"]*">([^<]+)<\/h1>/,
    `<h1 class="text-xl font-semibold">{m['${title}']()}</h1>`,
  );
  content = content.replace(
    /<p class="text-sm text-base-content\/50">([^<]+)<\/p>/,
    (full, text) => {
      if (full.includes('m[')) return full;
      return `<p class="text-sm text-base-content/50">{m['${sub}']()}</p>`;
    },
  );

  return content;
}

const en = JSON.parse(readFileSync(EN_PATH, 'utf8')) as Record<string, string>;
const ro = JSON.parse(readFileSync(RO_PATH, 'utf8')) as Record<string, string>;

let manifestPatched = 0;
let pagesPatched = 0;
let keysAdded = 0;

for (const extName of findExtensions(EXT_ROOT)) {
  const manifestPath = join(EXT_ROOT, extName, 'manifest.json');
  const pagePath = join(EXT_ROOT, extName, 'studio', 'pages', '+page.svelte');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name: string;
    displayName?: string;
    description?: string;
    category?: string;
    studio?: { navGroup?: string; pages?: Array<{ path: string; label: string }> };
  };

  const cat = manifest.category ?? extName.split('/')[0];
  const navGroup = CATEGORY_NAV[cat] ?? CATEGORY_NAV[extName.split('/')[0]] ?? 'other';
  if (!manifest.studio) manifest.studio = {};
  if (!manifest.studio.navGroup) {
    manifest.studio.navGroup = navGroup;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    manifestPatched++;
  }

  const key = msgKey(extName);
  const pageHtml = existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : '';
  const { h1, subtitle } = extractH1(pageHtml);
  const title = h1 ?? manifest.studio.pages?.[0]?.label ?? manifest.displayName ?? extName;
  const sub = subtitle ?? manifest.description ?? '';

  for (const suffix of ['title', 'subtitle', 'empty'] as const) {
    const k = `${key}.${suffix}`;
    if (!en[k]) {
      en[k] = suffix === 'empty' ? `No data yet.` : suffix === 'title' ? title : sub;
      ro[k] = ro[k] ?? en[k];
      keysAdded++;
    }
  }

  if (existsSync(pagePath) && !pageHtml.includes("from '$lib/i18n")) {
    const next = patchPage(pageHtml, key);
    if (next !== pageHtml) {
      writeFileSync(pagePath, next);
      pagesPatched++;
    }
  }
}

writeFileSync(EN_PATH, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO_PATH, JSON.stringify(ro, null, 2) + '\n');

console.log(`[batch-i18n] manifests navGroup: ${manifestPatched}`);
console.log(`[batch-i18n] message keys added: ${keysAdded}`);
console.log(`[batch-i18n] pages baseline patch: ${pagesPatched}`);
