/**
 * A value too long for `char(n)`/`varchar(n)` (22001) or out of range for its
 * numeric column (22003) is the client's mistake: 422, not 500. The ADR 0054
 * spike found a too-long `char` answering 500. Bun.SQL puts the SQLSTATE in
 * `errno`, so that is the shape pinned here.
 */
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { problemOnError } from '../../lib/problem.js';

function answer(errno: string) {
  const err = Object.assign(new Error('pg'), { code: 'ERR_POSTGRES_SERVER_ERROR', errno });
  const app = new Hono();
  app.onError(problemOnError);
  app.post('/x', () => {
    throw err;
  });
  return app.request('/x', { method: 'POST' });
}

describe('a value that does not fit its column', () => {
  it('22001 answers 422 value_too_long', async () => {
    const res = await answer('22001');
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('value_too_long');
  });
  it('22003 answers 422 value_out_of_range', async () => {
    const res = await answer('22003');
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('value_out_of_range');
  });
  it('an unrelated SQLSTATE stays a 500', async () => {
    expect((await answer('XX000')).status).toBe(500);
  });
});
