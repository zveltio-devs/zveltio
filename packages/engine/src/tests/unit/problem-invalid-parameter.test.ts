/**
 * A malformed `:id` is the caller's mistake, not the server's.
 *
 * Extensions register 463 routes carrying a path parameter and query the
 * database with it directly. `GET /ext/finance/invoicing/invoices/not-a-uuid`
 * therefore reaches Postgres as a uuid cast, and the 22P02 that comes back used
 * to render as a 500 — which tells an operator their instance is broken when
 * nothing is, and tells a caller nothing about what to fix.
 *
 * `problemOnError` maps it to 400. What is tested here is the branch that
 * actually fires in production and was the only part with no coverage: Bun.SQL
 * does not put the SQLSTATE in `code` the way node-pg does. It puts a generic
 * `ERR_POSTGRES_SERVER_ERROR` there and the real code in `errno`. A fix that
 * only checked `code` would pass every existing test — `mapPgError`'s suite
 * constructs `{ code: '22P02' }` by hand — and still return 500 on every
 * deployment, because every deployment runs Bun.SQL.
 *
 * So both shapes are pinned, and a 500 is asserted to still be a 500, because a
 * mapping that turns unrelated failures into 400 would hide real faults.
 */

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { problemOnError, PROBLEM_CONTENT_TYPE } from '../../lib/problem.js';

function appThrowing(err: unknown): Hono {
  const app = new Hono();
  app.onError(problemOnError);
  app.get('/thing/:id', () => {
    throw err;
  });
  return app;
}

/** What Bun.SQL actually raises: SQLSTATE in `errno`, not in `code`. */
function bunSqlError(): Error {
  const err = new Error('invalid input syntax for type uuid: "not-a-uuid"') as Error & {
    code: string;
    errno: string;
  };
  err.code = 'ERR_POSTGRES_SERVER_ERROR';
  err.errno = '22P02';
  return err;
}

/** What node-pg raises, kept so the branch does not regress if a driver changes. */
function nodePgError(): Error {
  const err = new Error('invalid input syntax for type uuid: "not-a-uuid"') as Error & {
    code: string;
  };
  err.code = '22P02';
  return err;
}

describe('invalid path parameters', () => {
  it('renders 400, not 500, for a Bun.SQL 22P02', async () => {
    const res = await appThrowing(bunSqlError()).request('/thing/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
    const body = await res.json();
    expect(body.code).toBe('invalid_parameter');
  });

  it('renders 400 for a node-pg 22P02', async () => {
    const res = await appThrowing(nodePgError()).request('/thing/not-a-uuid');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_parameter');
  });

  it('does not hand the driver message back to the caller', async () => {
    // `invalid input syntax for type uuid` names the column's type, which
    // describes the schema to anyone willing to type a wrong id. The envelope
    // says the parameter is malformed and stops there.
    //
    // `instance` is exempt and deliberately so: it is the request path, which is
    // the caller's own input echoed back per RFC 9457, not something they
    // learned here.
    const res = await appThrowing(bunSqlError()).request('/thing/not-a-uuid');
    const body = (await res.json()) as Record<string, string>;
    expect(body.detail).not.toContain('uuid');
    expect(body.detail).not.toContain('invalid input syntax');
    expect(body.instance).toBe('/thing/not-a-uuid');
  });

  it('leaves an unrelated failure as a 500', async () => {
    // The control. A mapping wide enough to catch everything would turn genuine
    // faults into client errors and quietly drop them out of alerting.
    const res = await appThrowing(new Error('connection reset')).request('/thing/1');
    expect(res.status).toBe(500);
  });
});
