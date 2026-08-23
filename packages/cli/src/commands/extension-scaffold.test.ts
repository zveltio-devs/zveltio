/**
 * What `extension create` puts on disk.
 *
 * The scaffold used to open with `studio/pages/+page.svelte` and mention
 * schemas in a parenthesis, which taught every new author the rare path first:
 * across the 56 shipped extensions there are 61 schemas and seven code pages,
 * and each of those seven sits beside a schema rather than instead of it.
 * These assertions pin the default, and pin the pieces that have to agree with
 * each other for `extension validate` to pass — the schema's dataSource against
 * a route the engine stub actually serves, and its labels against either the
 * catalogue the extension ships or the host's shared vocabulary.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SHARED_MESSAGE_KEYS } from '@zveltio/sdk/validate';
import { extensionCommand } from './extension.js';

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zv-scaffold-'));
  cwd = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const root = () => join(dir, 'extensions', 'operations', 'inventory');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('extension create — the default is a schema', () => {
  beforeEach(async () => {
    await extensionCommand('create', 'Inventory', { category: 'operations' });
  });

  it('writes the page as a schema, not a Svelte file', () => {
    expect(existsSync(join(root(), 'studio', 'schemas', 'inventory.json'))).toBe(true);
    expect(existsSync(join(root(), 'studio', 'pages'))).toBe(false);
  });

  it('points the manifest page at that schema', () => {
    const page = readJson(join(root(), 'manifest.json')).studio.pages[0];
    expect(page.schema).toBe('schemas/inventory.json');
  });

  it('names a dataSource the engine stub actually serves', () => {
    const schema = readJson(join(root(), 'studio', 'schemas', 'inventory.json'));
    const src = schema.resources[0].dataSource as string;
    // Inside the extension's own namespace, and matching a registered route.
    expect(src.startsWith('/ext/operations/inventory/')).toBe(true);
    const route = src.replace('/ext/operations/inventory', '');
    const engine = readFileSync(join(root(), 'engine', 'index.ts'), 'utf8');
    expect(engine).toContain(`app.get('${route}'`);
  });

  it('resolves every label, from its own catalogue or the shared one', () => {
    const schema = readJson(join(root(), 'studio', 'schemas', 'inventory.json'));
    const own = new Set(Object.keys(readJson(join(root(), 'studio', 'messages', 'en.json'))));
    const shared = new Set(SHARED_MESSAGE_KEYS);
    const keys = [
      schema.title,
      schema.subtitle,
      schema.resources[0].search.placeholder,
      ...schema.resources[0].columns.map((c: { label: string }) => c.label),
    ];
    for (const k of keys) {
      expect(own.has(k) || shared.has(k)).toBe(true);
    }
  });

  it('ships only the keys it owns — shared vocabulary is not re-declared', () => {
    const own = Object.keys(readJson(join(root(), 'studio', 'messages', 'en.json')));
    expect(own.every((k) => !k.startsWith('common.'))).toBe(true);
  });

  it('isolates its table by tenant, with the host predicate and FORCE', () => {
    const sql = readFileSync(join(root(), 'engine', 'migrations', '001_init.sql'), 'utf8');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('zveltio_tenant_scope_ok(tenant_id)');
    // The policy name is what the engine's boot reconciler looks for.
    expect(sql).toMatch(/CREATE POLICY tenant_isolation_\w+/);
  });
});

describe('extension create --code-page — the escape hatch', () => {
  beforeEach(async () => {
    await extensionCommand('create', 'Inventory', { category: 'operations', codePage: true });
  });

  it('writes a Svelte page and no schema', () => {
    expect(existsSync(join(root(), 'studio', 'pages', '+page.svelte'))).toBe(true);
    expect(existsSync(join(root(), 'studio', 'schemas'))).toBe(false);
  });

  it('leaves `schema` off the manifest page, so the host renders the code', () => {
    const page = readJson(join(root(), 'manifest.json')).studio.pages[0];
    expect(page.schema).toBeUndefined();
  });
});
