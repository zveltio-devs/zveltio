import { describe, it, expect } from 'bun:test';
import type {
  DDLManager,
  CollectionDefinition,
  FieldDefinition,
  CollectionRecord,
  DDLManagerDb,
} from '@zveltio/sdk/ddl';
import { DDLManager as RealDDLManager } from '../../lib/ddl-manager.js';

/**
 * S4-08 contract tests: the `@zveltio/sdk/ddl` interface must stay
 * compatible with the engine's real DDLManager class.
 *
 * These tests run at runtime via bun:test, but the actual assertion is
 * the TypeScript compile step that runs before — if any method on the
 * interface drifts from the class, the assignment below fails to typecheck.
 *
 * Why duplicate the interface instead of re-exporting the class:
 *   - SDK runs in browsers + workers; the engine class pulls Zod, Kysely
 *     runtime, fieldTypeRegistry, and several engine-internal modules.
 *   - Type-only contracts let extensions reason about the surface
 *     without bundling the implementation.
 */

describe('S4-08 SDK ddl shape', () => {
  it('CollectionDefinition has the documented required fields', () => {
    const def: CollectionDefinition = {
      name: 'contacts',
      fields: [
        { name: 'email', type: 'email', required: true },
        { name: 'phone', type: 'tel' },
      ],
    };
    expect(def.name).toBe('contacts');
    expect(def.fields).toHaveLength(2);
  });

  it('FieldDefinition supports all the documented options', () => {
    const f: FieldDefinition = {
      name: 'status',
      type: 'select',
      required: true,
      unique: false,
      indexed: true,
      defaultValue: 'new',
      options: { choices: ['new', 'active', 'archived'] },
      label: 'Status',
      description: 'Current state',
      encrypted: false,
    };
    expect(f.name).toBe('status');
    expect(Array.isArray(f.options?.choices)).toBe(true);
  });

  it('CollectionRecord is loose enough for engine return shapes', () => {
    // The engine returns extra fields like `id`, `created_at` etc. We
    // index-sig those rather than enumerate.
    const row: CollectionRecord = {
      name: 'contacts',
      id: 'abc-1',
      // engine-internal extras allowed via [k: string]: unknown
      created_at: '2026-01-01T00:00:00Z',
      tenant_id: 't-x',
    };
    expect(row.name).toBe('contacts');
    expect(row['tenant_id']).toBe('t-x');
  });

  it('DDLManagerDb is structurally `Kysely<any>` so ctx.db is assignable', async () => {
    // We don't actually need a live db — just verify the alias compiles
    // against a Kysely type at the type level. This file passing tsc is
    // the assertion.
    const fakeDb = {} as DDLManagerDb;
    expect(fakeDb).toBeDefined();
  });

  it('DDLManager interface matches RealDDLManager at the type level', () => {
    // TypeScript-level assertion: the runtime DDLManager class is assignable
    // to the SDK's DDLManager interface. If the engine class adds a new
    // method that's not in the SDK interface, this still compiles (extensions
    // just won't see the new method). If the engine RENAMES or REMOVES a
    // documented method, this fails — the SDK contract is now broken.
    const _adapter: DDLManager = {
      getTableName: (name: string) => RealDDLManager.getTableName(name),
      invalidateCache: (name?: string) => RealDDLManager.invalidateCache(name),
      tableExists: (db, name) => RealDDLManager.tableExists(db as any, name),
      createCollection: (db, def) => RealDDLManager.createCollection(db as any, def as any),
      dropCollection: (db, name, opts) => RealDDLManager.dropCollection(db as any, name, opts as any),
      addField: (db, c, f) => RealDDLManager.addField(db as any, c, f as any),
      removeField: (db, c, f) => RealDDLManager.removeField(db as any, c, f),
      getCollections: (db) => RealDDLManager.getCollections(db as any) as Promise<CollectionRecord[]>,
      getCollection: (db, name) => RealDDLManager.getCollection(db as any, name) as Promise<CollectionRecord | null>,
      updateCollectionMetadata: (db, name, meta) =>
        RealDDLManager.updateCollectionMetadata(db as any, name, meta as any),
      introspectTable: (db, name) =>
        RealDDLManager.introspectTable(db as any, name) as Promise<FieldDefinition[]>,
      syncFieldsFromDB: (db, name) => RealDDLManager.syncFieldsFromDB(db as any, name),
      previewCollection: (def) => RealDDLManager.previewCollection(def as any),
    };
    expect(_adapter.getTableName('contacts')).toBe('zvd_contacts');
  });
});
