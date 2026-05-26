import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

export const LOCALES = ['en', 'ro', 'fr', 'de'] as const;
export type Locale = (typeof LOCALES)[number];

export const CORE_PREFIXES = new Set([
  'common',
  'nav',
  'shell',
  'auth',
  'palette',
  'passkey',
  'account',
  'ext',
]);

export function findExtensions(base: string, prefix = ''): string[] {
  const names: string[] = [];
  if (!existsSync(base)) return names;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (existsSync(join(base, entry.name, 'manifest.json'))) names.push(rel);
    else names.push(...findExtensions(join(base, entry.name), rel));
  }
  return names;
}

export function namespaceForExt(extPath: string): string {
  return extPath.replace(/\//g, '.');
}

/** Which extension owns a message key (or `core`). */
export function ownerForKey(key: string, extensions: string[]): 'core' | string {
  if (CORE_PREFIXES.has(key.split('.')[0] ?? '')) return 'core';

  let best: { path: string; score: number } | null = null;
  for (const extPath of extensions) {
    const ns = namespaceForExt(extPath);
    const short = extPath.split('/').pop() ?? extPath;
    let score = 0;
    if (key === ns || key.startsWith(`${ns}.`)) score = ns.length + 1000;
    else if (key === short || key.startsWith(`${short}.`)) score = short.length + 100;
    if (score > 0 && (!best || score > best.score)) best = { path: extPath, score };
  }
  return best?.path ?? 'core';
}

export function sortKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((k) => [k, obj[k]!]),
  );
}
