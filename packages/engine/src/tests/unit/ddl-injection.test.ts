/**
 * DDL injection guards.
 *
 * A column DEFAULT is a caller-supplied string that reaches raw SQL — a DEFAULT
 * clause cannot be parameterised. It is reachable by a tenant admin, who is
 * deliberately not given the SQL editor, and the pool speaks Postgres'
 * simple-query protocol, which happily runs several statements in one command.
 *
 * Ghost migrations no longer take SQL fragments at all: see
 * ghost-ddl-operations.test.ts.
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
