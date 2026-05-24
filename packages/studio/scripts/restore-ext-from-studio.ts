#!/usr/bin/env bun
/** Copy migrated extension pages from Studio routes back to zveltio-extensions. */
import { existsSync, mkdirSync, cpSync, readdirSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT = join(STUDIO, '../../../zveltio-extensions');
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

let restored = 0;
for (const extName of findExtensions(EXT)) {
  const manifestPath = join(EXT, extName, 'manifest.json');
  const pagesDir = join(EXT, extName, 'studio', 'pages');
  if (!existsSync(pagesDir)) continue;

  let slug = extName;
  try {
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      studio?: { pages?: Array<{ path: string }> };
    };
    const firstPage = manifest.studio?.pages?.[0];
    if (firstPage?.path) {
      slug = firstPage.path.replace(/^\/admin\//, '').replace(/^\//, '');
    }
  } catch {
    /* use extName */
  }

  const src = join(ROUTES, slug);
  if (!existsSync(src)) continue;

  mkdirSync(pagesDir, { recursive: true });
  cpSync(src, pagesDir, { recursive: true });
  console.log(`[restore-ext] ${slug} → ${extName}`);
  restored++;
}

console.log(`[restore-ext] Done — ${restored} extension(s).`);
