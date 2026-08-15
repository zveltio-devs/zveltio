import { describe, it, expect } from 'bun:test';
import { parseMigrationSql } from '../../lib/extensions/extension-loader.js';

describe('parseMigrationSql', () => {
  it('treats a file without a DOWN marker as UP-only', () => {
    const raw = `CREATE TABLE foo (id UUID PRIMARY KEY);`;
    const parsed = parseMigrationSql(raw);
    expect(parsed.up).toBe('CREATE TABLE foo (id UUID PRIMARY KEY);');
    expect(parsed.down).toBeNull();
  });

  it('splits UP and DOWN on the marker line', () => {
    const raw = [
      'CREATE TABLE foo (id UUID PRIMARY KEY);',
      'CREATE INDEX idx_foo ON foo(id);',
      '',
      '-- DOWN',
      'DROP INDEX IF EXISTS idx_foo;',
      'DROP TABLE IF EXISTS foo;',
    ].join('\n');
    const parsed = parseMigrationSql(raw);
    expect(parsed.up).toContain('CREATE TABLE foo');
    expect(parsed.up).toContain('CREATE INDEX idx_foo');
    expect(parsed.up).not.toContain('DROP');
    expect(parsed.down).toContain('DROP INDEX IF EXISTS idx_foo');
    expect(parsed.down).toContain('DROP TABLE IF EXISTS foo');
  });

  it('is case-insensitive on the marker', () => {
    const raw = `CREATE TABLE bar (id INT);\n-- down\nDROP TABLE bar;`;
    const parsed = parseMigrationSql(raw);
    expect(parsed.up).toContain('CREATE TABLE bar');
    expect(parsed.down).toContain('DROP TABLE bar');
  });

  it('treats an empty DOWN section as null', () => {
    const raw = `CREATE TABLE baz (id INT);\n-- DOWN\n`;
    const parsed = parseMigrationSql(raw);
    expect(parsed.up).toContain('CREATE TABLE baz');
    expect(parsed.down).toBeNull();
  });

  it('trims whitespace around UP', () => {
    const raw = `\n\n  CREATE TABLE qux (id INT);  \n\n-- DOWN\nDROP TABLE qux;`;
    const parsed = parseMigrationSql(raw);
    expect(parsed.up.startsWith('CREATE')).toBe(true);
    expect(parsed.up.endsWith(';')).toBe(true);
  });

  it('handles a marker with no trailing newline (last line)', () => {
    const raw = `CREATE TABLE solo (id INT);\n-- DOWN`;
    const parsed = parseMigrationSql(raw);
    expect(parsed.up).toContain('CREATE TABLE solo');
    expect(parsed.down).toBeNull();
  });

  /**
   * `-- DOWN: manual rollback required` is a comment about the migration, not
   * the section marker. The parser used to match any line beginning `-- DOWN`,
   * so this ended the UP section and every statement after it was silently
   * discarded — the install reports success with half a schema.
   *
   * Measured on the engine's own `001_initial.sql`, which contains exactly that
   * line at 1207: the loose rule builds 61 tables, the anchored rule 113.
   */
  it('does not treat an annotated comment as the DOWN marker', () => {
    const raw = [
      'CREATE TABLE foo (id UUID PRIMARY KEY);',
      '',
      '-- DOWN: manual rollback required',
      '-- To revert: ALTER DATABASE <db> RESET "zveltio.current_tenant";',
      '',
      'CREATE TABLE bar (id UUID PRIMARY KEY);',
    ].join('\n');
    const parsed = parseMigrationSql(raw);
    expect(parsed.down).toBeNull();
    // The point: the table declared AFTER the annotated comment survives.
    expect(parsed.up).toContain('CREATE TABLE bar');
  });

  it('still splits when the annotated comment is followed by a real marker', () => {
    const raw = [
      'CREATE TABLE foo (id UUID PRIMARY KEY);',
      '-- DOWN: manual rollback required',
      'CREATE TABLE bar (id UUID PRIMARY KEY);',
      '-- DOWN',
      'DROP TABLE IF EXISTS bar;',
    ].join('\n');
    const parsed = parseMigrationSql(raw);
    expect(parsed.up).toContain('CREATE TABLE bar');
    expect(parsed.down).toBe('DROP TABLE IF EXISTS bar;');
  });

  it('tolerates trailing whitespace on the marker line', () => {
    const parsed = parseMigrationSql('CREATE TABLE foo (id UUID);\n--  down   \nDROP TABLE foo;');
    expect(parsed.down).toBe('DROP TABLE foo;');
  });
});
