#!/usr/bin/env bun
/**
 * Set studio.navGroup on every extension manifest (explicit sidebar grouping).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const EXT = join(import.meta.dir, '..', '../../../zveltio-extensions');

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

function resolveNavGroup(extName: string, category?: string): string {
  const cat = category ?? extName.split('/')[0] ?? '';
  return CATEGORY_NAV[cat] ?? CATEGORY_NAV[extName.split('/')[0] ?? ''] ?? 'other';
}

let patched = 0;
for (const extName of findExtensions(EXT)) {
  const path = join(EXT, extName, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    name: string;
    category?: string;
    studio?: Record<string, unknown>;
  };
  const navGroup = resolveNavGroup(manifest.name ?? extName, manifest.category);
  if (!manifest.studio) manifest.studio = {};
  const prev = (manifest.studio as { navGroup?: string }).navGroup;
  if (prev === navGroup) continue;
  (manifest.studio as { navGroup: string }).navGroup = navGroup;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${extName} → ${navGroup}`);
  patched++;
}

console.log(`\n[patch-nav-group] updated ${patched} manifest(s).`);
