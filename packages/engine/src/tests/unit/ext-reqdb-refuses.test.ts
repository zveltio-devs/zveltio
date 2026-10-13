import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { buildRestrictedContext } from '../../lib/extensions/register.js';

describe('ctx.reqDb', () => {
  const pool = { pool: true };
  const ctx = buildRestrictedContext(
    { db: pool } as never,
    'test/reqdb',
    new Hono(),
    undefined,
    false,
  );
  const req = (trx: unknown) => ({ get: (k: string) => (k === 'tenantTrx' ? trx : undefined) });

  it('refuses a request with no tenant transaction instead of falling back to the pool', () => {
    expect(() => ctx.reqDb!(req(null) as never)).toThrow('no tenant transaction');
  });

  it("hands back the request's transaction, behind the table guard", () => {
    expect(ctx.reqDb!(req({ trx: true }) as never)).toBeDefined();
  });
});
