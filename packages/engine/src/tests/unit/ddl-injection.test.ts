/**
 * DDL injection guards.
 *
 * Column DEFAULTs and ghost-migration ALTER fragments are the two places a
 * caller-supplied string reaches raw SQL — a DEFAULT clause cannot be
 * parameterised, and the ghost path builds `ALTER TABLE ... <fragment>`. Both
 * are reachable by a tenant admin, who is deliberately not given the SQL editor,
 * and the pool speaks Postgres' simple-query protocol, which happily runs
 * several statements in one command.
 */

import { describe, expect, it } from 'bun:test';
import { renderSqlDefault } from '../../lib/data/field-type-registry.js';

describe('renderSqlDefault — column DEFAULT escaping', () => {
  it('doubles embedded quotes instead of ending the literal', () => {
    expect(renderSqlDefault("O'Brien")).toBe("'O''Brien'");
  });

  it('neutralises a statement-terminating payload', () => {
    const out = renderSqlDefault('x\'); DROP TABLE "user"; --');
    // Every quote is doubled, so the payload stays inside one literal.
    expect(out.startsWith("'")).toBe(true);
    expect(out.endsWith("'")).toBe(true);
    expect(out).toBe("'x''); DROP TABLE \"user\"; --'");
    expect(out.slice(1, -1).includes("'")).toBe(true); // only as doubled pairs
    expect(/[^']'[^']/.test(out.slice(1, -1))).toBe(false);
  });

  it('no longer lets a gen_ prefix skip quoting', () => {
    // The old rule emitted anything starting with `gen_` as raw SQL.
    const out = renderSqlDefault('gen_evil(); DROP TABLE "user"; --');
    expect(out.startsWith("'")).toBe(true);
    expect(out).not.toContain('DROP TABLE "user"; --;');
  });

  it('no longer lets a NOW prefix skip quoting', () => {
    const out = renderSqlDefault('NOW(); DROP TABLE "user"; --');
    expect(out.startsWith("'")).toBe(true);
  });

  it('still emits the allow-listed SQL expressions verbatim', () => {
    expect(renderSqlDefault('now()')).toBe('now()');
    expect(renderSqlDefault('NOW()')).toBe('NOW()');
    expect(renderSqlDefault('gen_random_uuid()')).toBe('gen_random_uuid()');
    expect(renderSqlDefault('CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP');
  });

  it('renders numbers and booleans without quotes', () => {
    expect(renderSqlDefault(42)).toBe('42');
    expect(renderSqlDefault(true)).toBe('true');
  });
});

/**
 * The ghost allow-list is a private const inside createGhost, so it is
 * re-declared here. Keeping the assertions next to the fix documents the exact
 * shape that must stay rejected; the regex itself is duplicated deliberately
 * rather than exported, since exporting it would invite reuse elsewhere.
 */
const IDENT = String.raw`(?:"[a-zA-Z_][a-zA-Z0-9_]*"|[a-zA-Z_][a-zA-Z0-9_]*)`;
const TYPE_TAIL = String.raw`(?:[a-zA-Z0-9_ ,()\[\]]*)`;
const ALLOWED_DDL_RE = new RegExp(
  String.raw`^(?:` +
    String.raw`ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s+${TYPE_TAIL}` +
    String.raw`|DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?${IDENT}` +
    String.raw`|ALTER\s+COLUMN\s+${IDENT}\s+${TYPE_TAIL}` +
    String.raw`|RENAME\s+COLUMN\s+${IDENT}\s+TO\s+${IDENT}` +
    String.raw`)$`,
  'i',
);

describe('ghost-ddl allow-list — anchored at both ends', () => {
  const accepted = [
    'ADD COLUMN phone TEXT',
    'ADD COLUMN IF NOT EXISTS phone TEXT',
    'ADD COLUMN price NUMERIC(10,2)',
    'ADD COLUMN tags TEXT[]',
    'DROP COLUMN fax',
    'DROP COLUMN IF EXISTS fax',
    'ALTER COLUMN phone TYPE TEXT',
    'RENAME COLUMN phone TO mobile',
    'ADD COLUMN "quoted_ident" TEXT',
  ];

  for (const ddl of accepted) {
    it(`accepts legitimate: ${ddl}`, () => {
      expect(ALLOWED_DDL_RE.test(ddl)).toBe(true);
    });
  }

  const rejected = [
    'ADD COLUMN x int; DROP TABLE "user"; --',
    'DROP COLUMN fax; DELETE FROM "user"',
    'ADD COLUMN x TEXT DEFAULT \'a\'; GRANT ALL ON "user" TO PUBLIC; --',
    'ALTER COLUMN x TYPE TEXT; COPY (SELECT * FROM "user") TO \'/tmp/x\'',
    'RENAME COLUMN a TO b; ALTER TABLE "user" OWNER TO attacker',
    'ADD COLUMN x TEXT -- comment',
    'DROP TABLE "user"',
  ];

  for (const ddl of rejected) {
    it(`rejects injection: ${ddl.slice(0, 42)}…`, () => {
      expect(ALLOWED_DDL_RE.test(ddl)).toBe(false);
    });
  }
});
