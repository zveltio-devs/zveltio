import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import { handlePgErrors, mapPgError } from '../../lib/data/write-pipeline.js';

describe('mapPgError', () => {
  it('returns null for falsy input', () => {
    expect(mapPgError(null)).toBeNull();
    expect(mapPgError(undefined)).toBeNull();
  });

  it('maps 42501 / RLS to 403', () => {
    const mapped = mapPgError({ code: '42501', message: 'permission denied' });
    expect(mapped?.status).toBe(403);
    expect(mapped?.body.error).toBe('row_level_security_violation');
  });

  it('maps RLS via message pattern when code is missing', () => {
    const mapped = mapPgError({ message: 'new row violates row-level security policy' });
    expect(mapped?.status).toBe(403);
  });

  it('maps 23503 foreign keys with parsed detail', () => {
    const mapped = mapPgError({
      code: '23503',
      detail: 'Key (parent_id)=(missing) is not present in table "zvd_contacts"',
    });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.error).toBe('foreign_key_violation');
    expect(mapped?.body.field).toBe('parent_id');
    expect(String(mapped?.body.message)).toContain('contacts');
  });

  it('maps 23505 unique violations with field detail', () => {
    const mapped = mapPgError({
      code: '23505',
      detail: 'Key (email)=(dup@x.com) already exists.',
    });
    expect(mapped?.status).toBe(409);
    expect(mapped?.body.field).toBe('email');
  });

  it('maps 23502 not-null violations', () => {
    const mapped = mapPgError({ code: '23502', column_name: 'title' });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.field).toBe('title');
  });

  it('maps 23514 check violations', () => {
    const mapped = mapPgError({ code: '23514', constraint_name: 'status_check' });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.constraint).toBe('status_check');
  });

  it('maps 22P02 invalid value syntax', () => {
    const mapped = mapPgError({ code: '22P02', message: 'invalid input syntax for type uuid' });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.error).toBe('invalid_value');
  });

  it('maps 42703 unknown column', () => {
    const mapped = mapPgError({ message: 'column "ghost" does not exist' });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.error).toBe('unknown_field');
  });

  it('returns null for unmapped errors', () => {
    expect(mapPgError({ code: 'XX000', message: 'something else' })).toBeNull();
  });
});

describe('handlePgErrors', () => {
  const ctx = {
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status }) as ReturnType<Context['json']>,
  } as Context;

  it('returns mapped JSON for known Postgres errors', async () => {
    const out = await handlePgErrors(ctx, async () => {
      throw { code: '23505', detail: 'Key (slug)=(x) already exists.' };
    });
    expect(out).toBeInstanceOf(Response);
    const res = out as Response;
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unique_violation');
  });

  it('re-throws unmapped errors', async () => {
    await expect(
      handlePgErrors(ctx, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
