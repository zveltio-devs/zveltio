import { describe, expect, it } from 'bun:test';
import { parseMigrationSql } from '../validate/migration-parse.js';

describe('parseMigrationSql', () => {
  it('splits on a line that is exactly -- DOWN', () => {
    expect(parseMigrationSql('CREATE TABLE a (id int);\n-- DOWN\nDROP TABLE a;')).toEqual({
      up: 'CREATE TABLE a (id int);',
      down: 'DROP TABLE a;',
    });
  });

  it('does not end UP at a comment that only starts with -- DOWN', () => {
    const raw =
      'CREATE TABLE a (id int);\n-- DOWN: manual rollback required\nCREATE TABLE b (id int);';
    expect(parseMigrationSql(raw)).toEqual({ up: raw, down: null });
  });

  it('accepts case and trailing spaces, like the engine', () => {
    expect(parseMigrationSql('SELECT 1;\n--  down  \nSELECT 2;').down).toBe('SELECT 2;');
  });
});
