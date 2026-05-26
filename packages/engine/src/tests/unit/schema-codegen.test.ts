import { describe, it, expect } from 'bun:test';
import { parseSchema, parseColumnList, emitTypeScript } from '@zveltio/sdk/codegen';

describe('parseColumnList', () => {
  it('parses simple column definitions', () => {
    const cols = parseColumnList(`
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);
    expect(cols).toHaveLength(3);
    expect(cols[0]).toMatchObject({ name: 'id', pgType: 'UUID', nullable: false });
    expect(cols[0].tsType).toBe('string');
    expect(cols[1]).toMatchObject({ name: 'name', nullable: false });
    expect(cols[2]).toMatchObject({ name: 'created_at', nullable: false });
    expect(cols[2].tsType).toBe('Date');
  });

  it('marks columns nullable when NOT NULL is absent', () => {
    const cols = parseColumnList(`id INT, note TEXT`);
    expect(cols[0].tsType).toBe('number | null');
    expect(cols[1].tsType).toBe('string | null');
  });

  it('skips table-level constraints', () => {
    const cols = parseColumnList(`
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id),
      PRIMARY KEY (id),
      UNIQUE (user_id)
    `);
    expect(cols.map((c) => c.name)).toEqual(['id', 'user_id']);
  });

  it('handles types with length modifiers', () => {
    const cols = parseColumnList(`
      sku VARCHAR(64) NOT NULL,
      price NUMERIC(10,2) NOT NULL
    `);
    expect(cols[0].tsType).toBe('string');
    expect(cols[1].tsType).toBe('number');
  });

  it('handles array types', () => {
    const cols = parseColumnList(`tags TEXT[] NOT NULL`);
    expect(cols[0].tsType).toBe('string[]');
  });

  it('handles JSONB as Record<string, unknown>', () => {
    const cols = parseColumnList(`metadata JSONB NOT NULL DEFAULT '{}'`);
    expect(cols[0].tsType).toBe('Record<string, unknown>');
  });

  it('falls back to unknown for exotic types', () => {
    const cols = parseColumnList(`coord GEOGRAPHY(POINT, 4326) NOT NULL`);
    expect(cols[0].name).toBe('coord');
    expect(cols[0].tsType).toBe('unknown');
  });

  it('handles quoted identifiers', () => {
    const cols = parseColumnList(`"col with space" TEXT NOT NULL`);
    expect(cols[0].name).toBe('col with space');
  });
});

describe('parseSchema', () => {
  it('parses a single CREATE TABLE', () => {
    const schema = parseSchema([
      `
      CREATE TABLE zv_forms (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT,
        fields JSONB NOT NULL DEFAULT '[]',
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
    ]);
    expect(schema.tables).toHaveLength(1);
    const t = schema.tables[0];
    expect(t.name).toBe('zv_forms');
    expect(t.columns.map((c) => c.name)).toEqual([
      'id',
      'name',
      'slug',
      'description',
      'fields',
      'active',
      'created_at',
    ]);
    expect(t.columns.find((c) => c.name === 'description')?.tsType).toBe('string | null');
    expect(t.columns.find((c) => c.name === 'fields')?.tsType).toBe('Record<string, unknown>');
  });

  it('merges ALTER TABLE ADD COLUMN into the existing table', () => {
    const schema = parseSchema([
      `CREATE TABLE zv_forms (id UUID PRIMARY KEY, name TEXT NOT NULL);`,
      `ALTER TABLE zv_forms ADD COLUMN slug TEXT NOT NULL;`,
      `ALTER TABLE zv_forms ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`,
    ]);
    expect(schema.tables).toHaveLength(1);
    const t = schema.tables[0];
    expect(t.columns.map((c) => c.name)).toEqual(['id', 'name', 'slug', 'created_at']);
  });

  it('keeps last-write semantics on column re-declaration via ALTER', () => {
    const schema = parseSchema([
      `CREATE TABLE x (id UUID PRIMARY KEY, val TEXT);`,
      // Hypothetical: someone re-adds val with a different shape via a later
      // migration. Our parser keeps the latest declaration.
      `ALTER TABLE x ADD COLUMN val INT NOT NULL;`,
    ]);
    const val = schema.tables[0].columns.find((c) => c.name === 'val')!;
    expect(val.tsType).toBe('number');
  });

  it('multiple tables across migrations', () => {
    const schema = parseSchema([
      `CREATE TABLE a (id UUID PRIMARY KEY);`,
      `CREATE TABLE b (id UUID PRIMARY KEY, a_id UUID NOT NULL);`,
    ]);
    expect(schema.tables.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('ignores comments', () => {
    const schema = parseSchema([
      `
      -- A comment with CREATE TABLE fake_table (id INT) in it.
      /* block comment with CREATE TABLE other_fake (x INT); */
      CREATE TABLE real_table (id UUID PRIMARY KEY);
    `,
    ]);
    expect(schema.tables).toHaveLength(1);
    expect(schema.tables[0].name).toBe('real_table');
  });

  it('skips CREATE INDEX / CREATE FUNCTION', () => {
    const schema = parseSchema([
      `
      CREATE TABLE t (id UUID PRIMARY KEY);
      CREATE INDEX idx_t_id ON t(id);
      CREATE FUNCTION foo() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;
    `,
    ]);
    expect(schema.tables).toHaveLength(1);
    expect(schema.tables[0].name).toBe('t');
  });

  it('handles IF NOT EXISTS on CREATE TABLE', () => {
    const schema = parseSchema([`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY);`]);
    expect(schema.tables).toHaveLength(1);
    expect(schema.tables[0].name).toBe('users');
  });
});

describe('emitTypeScript', () => {
  it('emits a Kysely-friendly interface', () => {
    const schema = parseSchema([
      `
      CREATE TABLE zv_forms (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true
      );
    `,
    ]);
    const ts = emitTypeScript(schema);
    expect(ts).toContain('export interface ExtensionSchema {');
    expect(ts).toContain('zv_forms: {');
    expect(ts).toContain('id: string;');
    expect(ts).toContain('name: string;');
    expect(ts).toContain('active: boolean;');
    expect(ts).toContain('// AUTO-GENERATED');
  });

  it('quotes identifiers that aren’t valid JS keys', () => {
    const schema = parseSchema([`CREATE TABLE "weird name" (id UUID PRIMARY KEY);`]);
    const ts = emitTypeScript(schema);
    expect(ts).toContain("'weird name': {");
  });

  it('handles empty schema gracefully', () => {
    const ts = emitTypeScript({ tables: [] });
    expect(ts).toContain('// No tables parsed from migrations.');
  });

  it('renders the optional banner', () => {
    const ts = emitTypeScript({ tables: [] }, { banner: 'from forms/engine/migrations' });
    expect(ts).toContain('// from forms/engine/migrations');
  });

  it('supports a custom interface name', () => {
    const ts = emitTypeScript({ tables: [] }, { interfaceName: 'FormsDB' });
    expect(ts).toContain('export interface FormsDB {');
  });
});

describe('end-to-end with a realistic forms migration', () => {
  it('matches the shape we expect for the forms extension', () => {
    const formsMigration = `
      CREATE TABLE zv_forms (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name         TEXT NOT NULL,
        slug         TEXT NOT NULL UNIQUE,
        description  TEXT,
        fields       JSONB NOT NULL DEFAULT '[]',
        target_collection TEXT,
        active       BOOLEAN NOT NULL DEFAULT true,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_zv_forms_slug ON zv_forms(slug);

      CREATE TABLE zv_form_submissions (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        form_id    UUID NOT NULL REFERENCES zv_forms(id) ON DELETE CASCADE,
        data       JSONB NOT NULL,
        ip         INET,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;
    const schema = parseSchema([formsMigration]);
    expect(schema.tables.map((t) => t.name)).toEqual(['zv_forms', 'zv_form_submissions']);

    const ts = emitTypeScript(schema, { banner: 'from forms/engine/migrations/001_forms.sql' });
    expect(ts).toContain('zv_forms: {');
    expect(ts).toContain('zv_form_submissions: {');
    expect(ts).toContain('description: string | null;');
    expect(ts).toContain('ip: string | null;'); // inet → string
  });
});
