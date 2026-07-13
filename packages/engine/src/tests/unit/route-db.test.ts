/**
 * route-db.ts — per-request tenant transaction resolver.
 */

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { reqDb } from '../../lib/route-db.js';

describe('reqDb', () => {
  it('returns the tenant transaction when tenantTrx is set on the context', async () => {
    const fallback = { pool: true };
    const trx = { tenant: true };
    const app = new Hono();
    app.get('/x', (c) => {
      c.set('tenantTrx', trx as never);
      const db = reqDb(c, fallback as never) as unknown;
      return c.json({ db: db === trx });
    });
    const res = await app.request('http://local/x');
    expect((await res.json()).db).toBe(true);
  });

  it('falls back to the global pool when no tenant transaction is bound', async () => {
    const fallback = { pool: true };
    const app = new Hono();
    app.get('/y', (c) => {
      const db = reqDb(c, fallback as never) as unknown;
      return c.json({ db: db === fallback });
    });
    const res = await app.request('http://local/y');
    expect((await res.json()).db).toBe(true);
  });
});
