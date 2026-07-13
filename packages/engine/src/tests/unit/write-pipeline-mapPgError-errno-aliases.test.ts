/**
 * mapPgError — alternate Postgres error property names (errno, column, constraint).
 */

import { describe, expect, it } from 'bun:test';
import { mapPgError } from '../../lib/data/write-pipeline.js';

describe('mapPgError — errno / column / constraint aliases', () => {
  it('reads SQLSTATE from errno when code is absent', () => {
    const mapped = mapPgError({ errno: '23502', column: 'title', message: 'null value' });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.error).toBe('not_null_violation');
    expect(mapped?.body.field).toBe('title');
  });

  it('maps unique violations with a parsed Key() detail message', () => {
    const mapped = mapPgError({
      code: '23505',
      detail: 'Key (email)=(dup@example.com) already exists.',
    });
    expect(mapped?.status).toBe(409);
    expect(mapped?.body.error).toBe('unique_violation');
    expect(String(mapped?.body.message)).toContain('email');
    expect(mapped?.body.field).toBe('email');
  });

  it('maps check violations using constraint instead of constraint_name', () => {
    const mapped = mapPgError({ code: '23514', constraint: 'status_check' });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.constraint).toBe('status_check');
  });

  it('maps foreign key violations with table name stripped from detail', () => {
    const mapped = mapPgError({
      code: '23503',
      detail: 'Key (author_id)=(missing) is not present in table "zvd_authors".',
    });
    expect(mapped?.status).toBe(422);
    expect(String(mapped?.body.message)).toContain('authors');
    expect(mapped?.body.field).toBe('author_id');
  });
});
