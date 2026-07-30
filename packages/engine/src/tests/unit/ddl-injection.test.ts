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
// The real matcher, not a copy of it — a duplicated regex would agree with
// whatever the source says, including when the source is wrong.
import { isAllowedGhostDdl } from '../../lib/data/ghost-ddl.js';

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
    // Real migrations from the harness suite — these were rejected by an
    // over-tight first version of this regex, which is a reminder that a guard
    // that blocks legitimate DDL is a broken guard, not a strict one.
    "ADD COLUMN extra TEXT NOT NULL DEFAULT ''",
    "ADD COLUMN tag TEXT NOT NULL DEFAULT 'migrated'",
    "ALTER COLUMN note SET DEFAULT 'ghost-default'",
    "ADD COLUMN alpha TEXT NOT NULL DEFAULT 'a'",
    "ADD COLUMN created TIMESTAMPTZ DEFAULT 'epoch'::timestamptz",
  ];

  for (const ddl of accepted) {
    it(`accepts legitimate: ${ddl}`, () => {
      expect(isAllowedGhostDdl(ddl)).toBe(true);
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
    // A closed empty literal followed by a second statement: the `;` sits
    // outside any literal, so the tail cannot absorb it.
    "ADD COLUMN x TEXT DEFAULT ''; DROP TABLE \"user\"; --'",
    'ALTER COLUMN n SET DEFAULT \'a\'; TRUNCATE "user"',
  ];

  for (const ddl of rejected) {
    it(`rejects injection: ${ddl.slice(0, 42)}…`, () => {
      expect(isAllowedGhostDdl(ddl)).toBe(false);
    });
  }
});
