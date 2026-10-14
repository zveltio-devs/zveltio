/**
 * The column write guard (migration 072) refuses with 42501. A path outside the
 * data API — an extension's `ctx.db` — reaches `problemOnError` with it, which
 * must answer 403, while any other 42501 (a missing GRANT is a server fault)
 * stays a 500.
 */

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { problemOnError } from '../../lib/problem.js';

function bunSqlError(errno: string, message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_POSTGRES_SERVER_ERROR', errno });
}

async function statusFor(err: Error): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = new Hono();
  app.onError(problemOnError);
  app.get('/', () => {
    throw err;
  });
  const res = await app.request('/');
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('column write guard refusals', () => {
  it('render 403 column_write_denied naming the fields', async () => {
    const r = await statusFor(
      bunSqlError('42501', 'column-level permission denies writing salary, notes on zvd_staff'),
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('column_write_denied');
    expect(r.body.detail).toBe('Fields are read-only for your role: salary, notes');
  });

  it('leave any other 42501 a 500', async () => {
    const r = await statusFor(bunSqlError('42501', 'permission denied for table zvd_staff'));
    expect(r.status).toBe(500);
  });
});
