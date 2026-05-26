import { describe, it, expect } from 'bun:test';
import { splitStatements } from '@zveltio/sdk/testing';

/**
 * Unit tests for the SQL statement splitter used by `applyMigrationStrings`
 * (S4-06 follow-up).
 *
 * The splitter has to be smart enough that migrations like:
 *   CREATE TYPE foo AS ENUM ('a', 'b');
 *   CREATE FUNCTION x() RETURNS void AS $$ BEGIN SELECT 1; END $$ LANGUAGE plpgsql;
 * are split on the outer `;` but NOT on the inner one inside the
 * dollar-quoted block. The Zveltio migration set has both styles.
 *
 * We don't test the testcontainers-backed `withTestDb` itself here —
 * that requires Docker and is run from a separate integration suite.
 */

describe('S4-06 splitStatements', () => {
  it('splits multiple plain statements', () => {
    const stmts = splitStatements('SELECT 1; SELECT 2; SELECT 3');
    expect(stmts.map((s) => s.trim())).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  it('drops empty trailing statements', () => {
    const stmts = splitStatements('SELECT 1;');
    expect(stmts.map((s) => s.trim()).filter(Boolean)).toEqual(['SELECT 1']);
  });

  it('respects single-quoted strings — semicolon inside is NOT a split', () => {
    const stmts = splitStatements("INSERT INTO x VALUES ('a; b'); SELECT 1");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("'a; b'");
  });

  it('handles escaped single quotes (Postgres style)', () => {
    const stmts = splitStatements("INSERT INTO x VALUES ('it''s; fine'); SELECT 1");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("'it''s; fine'");
  });

  it('does not split inside dollar-quoted $$ ... $$ blocks', () => {
    const sql = `
      CREATE FUNCTION add_one(a int) RETURNS int AS $$
        SELECT a + 1;
      $$ LANGUAGE sql;
      SELECT add_one(5);
    `;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('CREATE FUNCTION');
    expect(stmts[1].trim()).toBe('SELECT add_one(5)');
  });

  it('handles tagged dollar quotes $tag$ ... $tag$', () => {
    const sql = `
      DO $body$ BEGIN
        IF random() > 0.5 THEN RAISE NOTICE 'high'; ELSE RAISE NOTICE 'low'; END IF;
      END $body$;
      SELECT 1;
    `;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('$body$');
    expect(stmts[1].trim()).toBe('SELECT 1');
  });

  it('handles -- line comments containing semicolons', () => {
    const sql = `
      -- destroys things; do not run twice
      DROP TABLE x;
      SELECT 1;
    `;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('DROP TABLE x');
    expect(stmts[1].trim()).toBe('SELECT 1');
  });

  it('handles /* block comments */ containing semicolons', () => {
    const sql = `
      /* one;
         two;
         three */
      SELECT 1;
    `;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain('SELECT 1');
  });

  it('does not split inside CREATE FUNCTION ... $$ ... $$', () => {
    // Lifted from a Zveltio system migration. Verifies the splitter
    // survives the most complex shape we ship.
    const sql = `
      CREATE OR REPLACE FUNCTION zv_touch_updated_at() RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER zv_touch_zvd_x BEFORE UPDATE ON zvd_x FOR EACH ROW EXECUTE FUNCTION zv_touch_updated_at();
    `;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('CREATE OR REPLACE FUNCTION');
    expect(stmts[1]).toContain('CREATE TRIGGER');
  });

  it('emits an empty array for empty input', () => {
    expect(splitStatements('')).toEqual([]);
    expect(
      splitStatements('   \n\t  ')
        .map((s) => s.trim())
        .filter(Boolean),
    ).toEqual([]);
  });
});
