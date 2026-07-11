/**
 * mapPgError message-pattern fallbacks (lib/data/write-pipeline.ts).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import type { Context } from 'hono';
import { handlePgErrors, mapPgError } from '../../lib/data/write-pipeline.js';

describe('mapPgError — message-only patterns', () => {
  it('maps foreign key violations via message when code is absent', () => {
    const mapped = mapPgError({
      message: 'insert or update violates foreign key constraint "fk_parent"',
    });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.error).toBe('foreign_key_violation');
  });

  it('maps unique violations via duplicate key message', () => {
    const mapped = mapPgError({
      message: 'duplicate key value violates unique constraint "contacts_email_key"',
    });
    expect(mapped?.status).toBe(409);
    expect(mapped?.body.error).toBe('unique_violation');
  });

  it('maps not-null violations via message pattern', () => {
    const mapped = mapPgError({
      message: 'null value in column "title" violates not-null constraint',
    });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.error).toBe('not_null_violation');
  });

  it('maps check violations via message pattern', () => {
    const mapped = mapPgError({ message: 'new row violates check constraint "status_check"' });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.error).toBe('check_violation');
  });
});

describe('handlePgErrors — unmapped path', () => {
  const ctx = {
    json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  } as unknown as Context;

  it('logs and rethrows errors that mapPgError does not recognize', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        handlePgErrors(ctx, async () => {
          throw { name: 'PostgresError', code: '53300', message: 'too many connections' };
        }),
      ).rejects.toMatchObject({ code: '53300' });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('unmapped error'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
