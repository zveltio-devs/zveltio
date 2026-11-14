/**
 * What `extension create` puts on disk.
 *
 * The scaffold is the first extension most authors read, so it is the declared
 * model a shipped extension (`crm`) follows: a collection the engine creates
 * and owns, business logic as an action, the page as a `zveltio.view/2`
 * document (ADR 0002, ADR 0042). It used to write SQL migrations, a Hono
 * route over `ctx.db` and a view/1 schema, and every new author copied that.
 * These assertions pin the pieces that have to agree for `extension validate`
 * to pass: the view's collection, fields and action against the manifest and
 * the collection file, its labels against the catalogue or the shared one.
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

describe('extension create — the declared model', () => {
  beforeEach(async () => {
    await extensionCommand('create', 'Inventory', { category: 'operations' });
  });

  it('declares a collection and ships its file; no SQL, no Svelte', () => {
    const manifest = readJson(join(root(), 'manifest.json'));
    expect(manifest.collections).toEqual(['inventory_items']);
    const file = readJson(join(root(), 'schema', 'collections', 'inventory_items.json'));
    expect(file.name).toBe('inventory_items');
    expect(existsSync(join(root(), 'engine', 'migrations'))).toBe(false);
    expect(existsSync(join(root(), 'studio', 'pages'))).toBe(false);
  });

  it('declares the action the engine code exports, on its own collection', () => {
    const manifest = readJson(join(root(), 'manifest.json'));
    expect(manifest.actions.map((a: { name: string }) => a.name)).toEqual(['markDone']);
    expect(manifest.actions[0].permission.resource).toBe('inventory_items');
    const engine = readFileSync(join(root(), 'engine', 'index.ts'), 'utf8');
    expect(engine).toContain('async markDone(input, host)');
    expect(engine).toContain('host.collections.update(');
    expect(engine).not.toContain('ctx.db');
    expect(engine).not.toContain('app.get(');
  });

  it('writes the page as a view/2 over that collection and action', () => {
    const page = readJson(join(root(), 'manifest.json')).studio.pages[0];
    expect(page.schema).toBe('schemas/inventory.json');
    const view = readJson(join(root(), 'studio', 'schemas', 'inventory.json'));
    expect(view.spec).toBe('zveltio.view/2');
    expect(view.collection).toBe('inventory_items');
    expect(view.rowActions[0].action).toBe('markDone');
    const fields = new Set(
      readJson(join(root(), 'schema', 'collections', 'inventory_items.json')).fields.map(
        (f: { name: string }) => f.name,
      ),
    );
    for (const f of view.fields as { field: string }[]) {
      expect(fields.has(f.field) || f.field === 'created_at').toBe(true);
    }
  });

  it('resolves every label, from its own catalogue or the shared one', () => {
    const view = readJson(join(root(), 'studio', 'schemas', 'inventory.json'));
    const own = new Set(Object.keys(readJson(join(root(), 'studio', 'messages', 'en.json'))));
    const shared = new Set(SHARED_MESSAGE_KEYS);
    const keys = [
      view.title,
      ...view.fields.map((c: { label: string }) => c.label),
      ...view.rowActions.map((b: { label: string }) => b.label),
    ];
    for (const k of keys) {
      expect(own.has(k) || shared.has(k)).toBe(true);
    }
  });

  it('ships only the keys it owns — shared vocabulary is not re-declared', () => {
    const own = Object.keys(readJson(join(root(), 'studio', 'messages', 'en.json')));
    expect(own.every((k) => !k.startsWith('common.'))).toBe(true);
  });
});

describe('extension create --code-page — withdrawn (ADR 0042)', () => {
  it('refuses and writes nothing', async () => {
    const exit = process.exit;
    let code: number | undefined;
    process.exit = ((c?: number) => {
      code = c;
      throw new Error('exit');
    }) as typeof process.exit;
    try {
      await extensionCommand('create', 'Inventory', {
        category: 'operations',
        codePage: true,
      }).catch(() => {});
    } finally {
      process.exit = exit;
    }
    expect(code).toBe(1);
    expect(existsSync(root())).toBe(false);
  });
});
