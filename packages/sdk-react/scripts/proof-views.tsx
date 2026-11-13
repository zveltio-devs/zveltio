#!/usr/bin/env bun
/**
 * ADR 0042 acceptance, run in CI: a front end written without Svelte,
 * importing only the SDK, lists the extensions' pages and draws their views,
 * including the fallback.
 *
 * Builds an engine stand-in from the extensions catalogue (SIBLING_ROOT): the
 * manifests' pages as `GET /api/extensions` answers them, the declared
 * collections as `GET /api/data`, the actions as `GET /api/actions`, one record
 * per collection. Then `@zveltio/react` lists the pages (`extensionPages`),
 * reads each (`loadView`) and draws it on the server (`ViewRenderer`).
 *
 * Fails on: an empty catalogue, a page that does not validate, a page that
 * throws while read or drawn, a page whose HTML draws nothing.
 *
 * Usage: bun scripts/proof-views.tsx   (from packages/sdk-react)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { renderToString } from 'react-dom/server';
import type { ZveltioClient } from '@zveltio/sdk';
import { requireSibling, SIBLING_ROOT } from '../../../scripts/lib/require-sibling.ts';
import { extensionPages, type Loaded, loadView, ViewRenderer } from '../src/view.tsx';

requireSibling(SIBLING_ROOT, 'proof-views');

// biome-ignore lint/suspicious/noExplicitAny: manifest JSON read as found; `validateView` checks what is drawn
type Json = Record<string, any>;

function manifests(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) manifests(full, acc);
    else if (name === 'manifest.json') acc.push(full);
  }
  return acc;
}

const read = (f: string): Json | null => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

const meta: Json[] = [];
const collections = new Map<string, { name: string; type: string; is_system?: boolean }[]>();
const actions: Json[] = [];
for (const file of manifests(SIBLING_ROOT)) {
  const m = read(file);
  if (!m?.name) continue;
  const dir = dirname(file);
  const pages = (m.studio?.pages ?? []).map((p: Json) => ({
    ...p,
    schema: typeof p.schema === 'string' ? read(join(dir, 'studio', p.schema)) : p.schema,
  }));
  meta.push({ name: m.name, studio: { pages } });
  for (const c of m.collections ?? []) {
    const name = typeof c === 'string' ? c : c.name;
    const decl = read(join(dir, 'schema', 'collections', `${name}.json`));
    collections.set(name, [
      { name: 'id', type: 'uuid', is_system: true },
      ...((decl?.fields ?? []) as { name: string; type: string }[]),
    ]);
  }
  for (const a of m.actions ?? [])
    actions.push({ extension: m.name, name: a.name, input: a.input ?? {} });
}

const record = (c: string): Json =>
  Object.fromEntries(
    (collections.get(c) ?? []).map((f) => [f.name, f.name === 'id' ? 'r1' : `${c}.${f.name}`]),
  );

const engine = {
  get: async (path: string) => {
    if (path === '/api/extensions') return { extensions: meta.map((m) => m.name), meta };
    if (path === '/api/data')
      return { collections: [...collections].map(([name, fields]) => ({ name, fields })) };
    throw new Error(`unexpected GET ${path}`);
  },
  post: async () => ({ result: null }),
  collection: (c: string) => ({
    list: async () => ({ records: [record(c)], pagination: { total: 1, page: 1, limit: 25 } }),
    get: async () => record(c),
  }),
  actions: { list: async () => ({ actions }) },
} as unknown as ZveltioClient;

const kinds = (n: Loaded): string[] => [
  n.from ? `${n.from}→${n.kind}` : n.kind,
  ...('children' in n ? n.children.flatMap(kinds) : []),
  ...('panels' in n ? n.panels.flatMap(kinds) : []),
];

const host = {
  t: (s?: string) => s ?? '',
  scope: {},
  press: () => {},
  select: () => {},
  save: () => {},
};
const pages = await extensionPages(engine);
const failures: string[] = [];
const drawn = new Map<string, number>();
for (const p of pages) {
  const where = `${p.extension} ${p.path}`;
  if (!p.view.ok) {
    failures.push(
      `${where}: invalid — ${p.view.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
    );
    continue;
  }
  try {
    const node = await loadView(engine, p.extension, p.view.view, {
      params: { id: 'r1' },
      selected: {},
      user: 'u1',
    });
    const html = renderToString(<ViewRenderer node={node} host={host} />);
    if (!html.includes('zv-view')) failures.push(`${where}: drew nothing`);
    if (html.includes('is not drawn here')) failures.push(`${where}: a kind with no fallback`);
    for (const k of kinds(node)) drawn.set(k, (drawn.get(k) ?? 0) + 1);
  } catch (e) {
    failures.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

if (pages.length === 0)
  failures.push(`no view/2 page under ${relative(process.cwd(), SIBLING_ROOT) || '.'}`);
const summary = [...drawn]
  .sort()
  .map(([k, n]) => `${k} ${n}`)
  .join(', ');
if (failures.length) {
  console.error(`✗ proof-views: ${failures.length} of ${pages.length} pages failed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ proof-views: @zveltio/react drew ${pages.length} pages (${summary})`);
