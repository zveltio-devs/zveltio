/**
 * FieldTypeRegistry (lib/data/field-type-registry.ts) — the pure DDL/serialize/
 * validate engine behind every dynamic collection column. All methods are
 * deterministic, so a fresh registry + fixture types covers them exactly.
 */

import { describe, it, expect } from 'bun:test';
import { FieldTypeRegistry, type FieldTypeDefinition } from '../../lib/data/field-type-registry.js';
// biome-ignore lint/suspicious/noExplicitAny: dynamic field configs in tests
type Any = any;

function makeRegistry(): FieldTypeRegistry {
  const r = new FieldTypeRegistry();
  const text: FieldTypeDefinition = {
    type: 'text',
    label: 'Text',
    db: { columnType: 'TEXT' },
    api: {
      serialize: (v) => String(v),
      deserialize: (v) => (v == null ? v : String(v).trim()),
      validate: (v) => (typeof v === 'string' ? null : 'must be a string'),
    },
    typescript: { inputType: 'string', outputType: 'string' },
  };
  const geo: FieldTypeDefinition = {
    type: 'geo',
    label: 'Geometry',
    db: { columnType: 'geometry', indexType: 'gist', requiresExtensions: ['postgis'] },
    api: {},
    typescript: { inputType: 'GeoJSON', outputType: 'GeoJSON' },
  };
  const computed: FieldTypeDefinition = {
    type: 'computed',
    label: 'Computed',
    db: { columnType: 'TEXT', virtual: true },
    api: {},
    typescript: { inputType: 'never', outputType: 'string' },
  };
  const counter: FieldTypeDefinition = {
    type: 'counter',
    label: 'Counter',
    db: { columnType: 'INTEGER', defaultValue: '0' }, // string default → quoted as '0'
    api: {},
    typescript: { inputType: 'number', outputType: 'number' },
  };
  const uuid: FieldTypeDefinition = {
    type: 'uuid',
    label: 'UUID',
    db: { columnType: 'UUID', defaultValue: 'gen_random_uuid()' }, // SQL fn — unquoted
    api: {},
    typescript: { inputType: 'string', outputType: 'string' },
  };
  for (const d of [text, geo, computed, counter, uuid]) r.register(d);
  return r;
}

describe('FieldTypeRegistry — registration', () => {
  it('register / get / has / list / getAll', () => {
    const r = makeRegistry();
    expect(r.has('text')).toBe(true);
    expect(r.has('nope')).toBe(false);
    expect(r.get('text')?.label).toBe('Text');
    expect(r.list().sort()).toEqual(['computed', 'counter', 'geo', 'text', 'uuid']);
    expect(r.getAll()).toHaveLength(5);
  });
});

describe('FieldTypeRegistry — getColumnDDL', () => {
  const r = makeRegistry();

  it('builds a column with NOT NULL + UNIQUE', () => {
    const ddl = r.getColumnDDL({
      name: 'title',
      type: 'text',
      required: true,
      unique: true,
    } as Any);
    expect(ddl).toBe('"title" TEXT NOT NULL UNIQUE');
  });

  it('returns null for a virtual (computed) field', () => {
    expect(r.getColumnDDL({ name: 'c', type: 'computed' } as Any)).toBeNull();
  });

  it('throws on an unknown type', () => {
    expect(() => r.getColumnDDL({ name: 'x', type: 'ghost' } as Any)).toThrow('Unknown field type');
  });

  it('quotes a string default but not a gen_/NOW SQL function', () => {
    // gen_*/NOW* are emitted as raw SQL; every other string default is quoted
    // (Postgres implicitly casts `'0'` for an INTEGER column).
    expect(r.getColumnDDL({ name: 'u', type: 'uuid' } as Any)).toBe(
      '"u" UUID DEFAULT gen_random_uuid()',
    );
    expect(r.getColumnDDL({ name: 'n', type: 'counter' } as Any)).toBe(`"n" INTEGER DEFAULT '0'`);
    expect(r.getColumnDDL({ name: 't', type: 'text', defaultValue: 'hi' } as Any)).toBe(
      `"t" TEXT DEFAULT 'hi'`,
    );
  });

  it('a field defaultValue overrides the type default', () => {
    expect(r.getColumnDDL({ name: 'u', type: 'uuid', defaultValue: 'NOW()' } as Any)).toBe(
      '"u" UUID DEFAULT NOW()',
    );
  });
});

describe('FieldTypeRegistry — getIndexDDL', () => {
  const r = makeRegistry();

  it('emits a btree index (no USING) for an indexed field', () => {
    const ddl = r.getIndexDDL('zvd_x', { name: 'title', type: 'text', indexed: true } as Any);
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS idx_zvd_x_title ON zvd_x ("title")');
    expect(ddl).not.toContain('USING');
  });

  it('emits USING GIST for a type with a gist index', () => {
    const ddl = r.getIndexDDL('zvd_x', { name: 'shape', type: 'geo' } as Any);
    expect(ddl).toContain('USING GIST');
  });

  it('returns null when not indexed and the type has no index', () => {
    expect(r.getIndexDDL('zvd_x', { name: 'title', type: 'text' } as Any)).toBeNull();
  });

  it('returns null for a virtual field', () => {
    expect(
      r.getIndexDDL('zvd_x', { name: 'c', type: 'computed', indexed: true } as Any),
    ).toBeNull();
  });
});

describe('FieldTypeRegistry — getRequiredExtensions', () => {
  it('collects + dedupes extensions across fields', () => {
    const r = makeRegistry();
    const exts = r.getRequiredExtensions([
      { name: 'a', type: 'geo' },
      { name: 'b', type: 'geo' },
      { name: 'c', type: 'text' },
    ] as Any);
    expect(exts).toEqual(['postgis']);
  });
});

describe('FieldTypeRegistry — serialize / deserialize / validate', () => {
  const r = makeRegistry();

  it('delegates to the type functions', () => {
    expect(r.serialize('text', 42)).toBe('42');
    expect(r.deserialize('text', '  hi ')).toBe('hi');
    expect(r.validate('text', 5, {} as Any)).toBe('must be a string');
    expect(r.validate('text', 'ok', {} as Any)).toBeNull();
  });

  it('passes through when the type has no function or is unknown', () => {
    expect(r.serialize('geo', { x: 1 })).toEqual({ x: 1 }); // no serialize fn
    expect(r.deserialize('unknown', 'v')).toBe('v');
    expect(r.validate('unknown', 'v', {} as Any)).toBeNull();
  });
});

describe('FieldTypeRegistry — generateTypeScript', () => {
  it('capitalizes the name, marks optional fields, uses inputType (unknown → any)', () => {
    const r = makeRegistry();
    const ts = r.generateTypeScript('contact', [
      { name: 'name', type: 'text', required: true },
      { name: 'note', type: 'text' },
      { name: 'weird', type: 'ghost' },
    ] as Any);
    expect(ts).toContain('export interface ContactInput {');
    expect(ts).toContain('name: string;'); // required → no ?
    expect(ts).toContain('note?: string;'); // optional
    expect(ts).toContain('weird?: any;'); // unknown type falls back to any
    expect(ts).toContain('export interface Contact extends ContactInput {');
  });
});
