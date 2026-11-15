/**
 * DR-41: request-log rows reach the database together, one INSERT per flush,
 * not one pool connection per request.
 */

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { requestLogMiddleware } from '../../middleware/request-log.js';

describe('request log batching', () => {
  it('writes fifty requests in one INSERT', async () => {
    const inserts: unknown[][] = [];
    const poolDb = {
      insertInto: () => ({
        values: (rows: unknown[]) => ({
          execute: async () => {
            inserts.push(rows);
          },
        }),
      }),
    } as unknown as Database;
    const app = new Hono();
    app.use('*', requestLogMiddleware(poolDb));
    app.get('/api/x', (c) => c.json({ ok: true }));

    await Promise.all(Array.from({ length: 50 }, () => app.request('/api/x')));
    expect(inserts).toEqual([]);
    for (let i = 0; i < 40 && inserts.length === 0; i++) await Bun.sleep(25);

    expect(inserts.length).toBe(1);
    expect(inserts[0]!.length).toBe(50);
  });
});
