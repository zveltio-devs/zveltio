/**
 * A write that rolls back is announced to nobody.
 *
 * `afterWrite` ran the local WebSocket and SSE fan-out inside the request
 * transaction, before the commit. When the commit then failed, every subscriber
 * on this replica had already been told of a record that never existed. (#1335
 * moved the cross-instance bus publish after the commit; the local doors
 * stayed where they were.)
 *
 * Driven through the real route and the real tenant middleware: a deferred
 * unique constraint lets the INSERT through and fails the COMMIT, the one
 * failure that lands after `afterWrite` has run.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { realtimeBus } from '../../lib/runtime/index.js';
import * as realtime from '../../routes/realtime.js';
import * as ws from '../../routes/ws.js';
import {
  asEveryTenant,
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const C = `aftercommit_${Date.now()}`;

d('realtime fan-out waits for the commit', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const told: Record<'ws' | 'sse' | 'bus', string[]> = { ws: [], sse: [], bus: [] };
  const spies: Array<{ mockRestore(): void }> = [];

  const post = (title: string) =>
    app.request(`/api/data/${C}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title }),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql
      .raw(
        `ALTER TABLE "zvd_${C}" ADD CONSTRAINT "zvd_${C}_title_deferred"
           UNIQUE (title) DEFERRABLE INITIALLY DEFERRED`,
      )
      .execute(db);
    const title = (data: unknown) => String((data as { title?: unknown }).title);
    spies.push(
      spyOn(ws, 'broadcastEvent').mockImplementation((col, _e, data) => {
        if (col === C) told.ws.push(title(data));
      }),
      spyOn(realtime, 'broadcastDataEvent').mockImplementation((col, _e, data) => {
        if (col === C) told.sse.push(title(data));
      }),
      spyOn(realtimeBus(), 'publish').mockImplementation(async (m) => {
        if (m.collection === C) told.bus.push(title(m.data));
      }),
    );
  }, 60_000);

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    if (db) await dropTestCollection(db, C);
  });

  it('a committed write reaches every door', async () => {
    expect((await post('kept')).status).toBe(201);
    await Bun.sleep(100);
    expect(told).toEqual({ ws: ['kept'], sse: ['kept'], bus: ['kept'] });
  });

  it('a write whose COMMIT fails reaches none', async () => {
    const res = await post('kept'); // duplicate: the deferred constraint fails the COMMIT
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Every firm's rows: the owner lane's FORCE RLS shows only one firm's on the bare pool.
    const { rows } = await asEveryTenant(db, (trx) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(`zvd_${C}`)}`.execute(trx),
    );
    expect(rows[0]?.n).toBe(1);
    await Bun.sleep(100);
    expect(told).toEqual({ ws: ['kept'], sse: ['kept'], bus: ['kept'] });
  });
});
