/**
 * GET /api/admin/status says what is true.
 *
 * `status` was the literal 'ok', always — the endpoint reported a healthy
 * system while saying three lines down that the database was disconnected.
 *
 * This file used to assert a copy of the route's logic written inside the
 * test, so nothing the route did could fail it. It drives the real handler
 * now: a CannedDb whose queries answer or fail, and a cache whose ping does.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { registerSystemRoutes } from '../../routes/admin/system-routes.js';
import { CannedDb } from './fixtures/canned-db.js';

afterEach(() => _setCacheForTests(null));

type Body = {
  status: string;
  database: { status: string; version: string; tables: number | null };
  cache: { status: string };
};

async function status(db: CannedDb, cache: 'none' | 'up' | 'down' = 'none'): Promise<Body> {
  if (cache === 'none') _setCacheForTests(null);
  else {
    _setCacheForTests({
      ping: async () => {
        if (cache === 'down') throw new Error('ECONNREFUSED');
        return 'PONG';
      },
    } as never);
  }
  const app = new Hono();
  registerSystemRoutes(app, db.kysely as unknown as Database);
  const res = await app.request('/status');
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

function healthyDb(tables: string | null = '113'): CannedDb {
  const db = new CannedDb();
  db.when(/select version\(\)/i, [{ version: 'PostgreSQL 18' }]);
  if (tables === null) db.fail(/information_schema\.tables/i);
  else db.when(/information_schema\.tables/i, [{ count: tables }]);
  db.when(/^select 1$/i, [{ '?column?': 1 }]);
  return db;
}

describe('system status says what is true', () => {
  it('is ok only when everything answered', async () => {
    expect((await status(healthyDb(), 'up')).status).toBe('ok');
    expect((await status(healthyDb(), 'none')).cache.status).toBe('not_configured');
    expect((await status(healthyDb(), 'none')).status).toBe('ok');
  });

  it('does not report ok while the database is down', async () => {
    const db = new CannedDb();
    db.fail(/./);
    const body = await status(db, 'up');
    expect(body.status).toBe('degraded');
    expect(body.database.status).toBe('disconnected');
    expect(body.database.version).toBe('unknown');
  });

  it('degrades when the cache is down', async () => {
    const body = await status(healthyDb(), 'down');
    expect(body.cache.status).toBe('disconnected');
    expect(body.status).toBe('degraded');
  });

  it('reports an uncountable table count as null, not as zero and not as NaN', async () => {
    expect((await status(healthyDb(null))).database.tables).toBeNull();
  });

  it('still reports a real zero as zero', async () => {
    expect((await status(healthyDb('0'))).database.tables).toBe(0);
  });
});
