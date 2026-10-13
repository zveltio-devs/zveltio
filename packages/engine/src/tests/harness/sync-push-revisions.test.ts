/**
 * A sync push leaves the same trail as `/api/data`: a revision `?as_of=` can
 * read back, and `afterWrite`'s side effects (webhooks, realtime, flows,
 * `record.*` listeners).
 *
 * Measured on this harness before the repair:
 *
 * - `update` and `delete` called no `afterWrite` at all. An offline edit or
 *   delete landed with no revision, no webhook and no realtime nudge, so
 *   `?as_of=` after an offline delete still served the record;
 * - `create` called it with the TABLE name (`zvd_<name>`). Revisions are read
 *   by collection name, so `?as_of=` never found a record created offline,
 *   webhooks and listeners subscribed to `<name>` never heard of it, and the
 *   withheld-column lookup (`password`, encrypted fields) found no collection
 *   and stripped nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { engineEvents } from '../../lib/runtime/index.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLL = `spr_${String(Date.now()).slice(-8)}`;

d('sync push writes revisions and fires afterWrite (in-process)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  const cookies: Record<string, string> = {};
  const events: Array<{ event: string; id: string; record: Record<string, unknown> }> = [];
  const offs: Array<() => void> = [];

  const push = async (who: string, operations: unknown[]) =>
    (
      (await (
        await app.request('/api/sync/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie: cookies[who]! },
          body: JSON.stringify({ operations }),
        })
      ).json()) as { results: Array<{ recordId: string; status: string }> }
    ).results;
  const asOf = async (id: string, at: string) => {
    const res = await app.request(`/api/data/${COLL}/${id}?as_of=${encodeURIComponent(at)}`, {
      headers: { cookie: god },
    });
    return { status: res.status, body: (await res.json()) as { record?: Record<string, unknown> } };
  };
  // Each push is its own transaction, so its revisions carry its own NOW().
  const instant = async () => {
    await Bun.sleep(15);
    const at = new Date().toISOString();
    await Bun.sleep(15);
    return at;
  };
  const revisions = async (id: string) =>
    (
      await sql<{ action: string; data: Record<string, unknown>; delta: unknown }>`
        SELECT action, data, delta FROM zv_revisions
         WHERE collection = ${COLL} AND record_id = ${id} ORDER BY created_at`.execute(db)
    ).rows;
  const eventsFor = (id: string) => events.filter((e) => e.id === id);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'note', type: 'text', required: false, unique: false, indexed: false },
        { name: 'pw', type: 'password', required: false, unique: false, indexed: false },
      ],
    } as never);
    for (const [who, actions] of [
      ['reader', ['read', 'create', 'update', 'delete']],
      ['writeOnly', ['create', 'update', 'delete']],
    ] as const) {
      cookies[who] = (
        await createMemberSession(app, db, {
          grants: [{ collection: COLL, actions: [...actions] }],
        })
      ).cookie;
    }
    for (const event of ['record.created', 'record.updated', 'record.deleted'] as const) {
      offs.push(
        // `afterWrite` emits `{ collection, record, id, … }` for all three.
        engineEvents.on(event, (payload) => {
          const p = payload as unknown as { collection: string; id: string; record: unknown };
          if (p.collection === COLL)
            events.push({ event, id: p.id, record: p.record as Record<string, unknown> });
        }),
      );
    }
  }, 60_000);

  afterAll(async () => {
    for (const off of offs) off();
    if (!db) return;
    await sql`DELETE FROM zv_revisions WHERE collection IN (${COLL}, ${`zvd_${COLL}`})`
      .execute(db)
      .catch(() => {});
    await dropTestCollection(db, COLL).catch(() => {});
  });

  it('create, update and delete each leave a full-row revision ?as_of= reads back', async () => {
    const id = crypto.randomUUID();
    expect(
      await push('reader', [
        {
          collection: COLL,
          recordId: id,
          operation: 'create',
          payload: { title: 'v1', note: 'kept', pw: 'correct horse battery' },
        },
      ]),
    ).toEqual([expect.objectContaining({ recordId: id, status: 'ok' })]);
    const afterCreate = await instant();

    expect(
      await push('reader', [
        { collection: COLL, recordId: id, operation: 'update', payload: { title: 'v2' } },
      ]),
    ).toEqual([expect.objectContaining({ recordId: id, status: 'ok' })]);
    const afterUpdate = await instant();

    expect(
      await push('reader', [{ collection: COLL, recordId: id, operation: 'delete', payload: {} }]),
    ).toEqual([expect.objectContaining({ recordId: id, status: 'ok' })]);
    const afterDelete = await instant();

    const v1 = await asOf(id, afterCreate);
    expect(v1.status).toBe(200);
    expect(v1.body.record).toMatchObject({ id, title: 'v1', note: 'kept' });

    // The whole row, not the pushed `{ title }`: `note` was not in the update.
    const v2 = await asOf(id, afterUpdate);
    expect(v2.status).toBe(200);
    expect(v2.body.record).toMatchObject({ id, title: 'v2', note: 'kept' });

    expect((await asOf(id, afterDelete)).status).toBe(404);

    const revs = await revisions(id);
    expect(revs.map((r) => r.action)).toEqual(['create', 'update', 'delete']);
    expect(revs[1]!.delta).toMatchObject({ title: 'v2' });
    expect(revs[2]!.data).toMatchObject({ id, title: 'v2', note: 'kept' });

    expect(eventsFor(id).map((e) => e.event)).toEqual([
      'record.created',
      'record.updated',
      'record.deleted',
    ]);
    for (const e of eventsFor(id)) {
      expect(e.record).toMatchObject({ id, note: 'kept' });
      // What leaves the write path is what REST serves: no password hash.
      expect('pw' in e.record).toBe(false);
    }
  });

  it('a caller who cannot read: the revisions still carry the whole row', async () => {
    const made = await app.request(`/api/data/${COLL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ title: 'w1', note: 'kept' }),
    });
    const id = ((await made.json()) as { id: string }).id;

    expect(
      await push('writeOnly', [
        { collection: COLL, recordId: id, operation: 'update', payload: { title: 'w2' } },
      ]),
    ).toEqual([expect.objectContaining({ recordId: id, status: 'ok' })]);
    const afterUpdate = await instant();
    expect(
      await push('writeOnly', [
        { collection: COLL, recordId: id, operation: 'delete', payload: {} },
      ]),
    ).toEqual([expect.objectContaining({ recordId: id, status: 'ok' })]);

    expect((await asOf(id, afterUpdate)).body.record).toMatchObject({ title: 'w2', note: 'kept' });
    const revs = await revisions(id);
    expect(revs.map((r) => r.action)).toEqual(['create', 'update', 'delete']);
    expect(revs[2]!.data).toMatchObject({ id, title: 'w2', note: 'kept' });
    expect(eventsFor(id).map((e) => e.event)).toEqual([
      'record.created',
      'record.updated',
      'record.deleted',
    ]);
  });

  it('a row the WHERE skips is a conflict, with no revision and no event', async () => {
    const id = crypto.randomUUID();
    expect(
      await push('reader', [
        { collection: COLL, recordId: id, operation: 'update', payload: { title: 'x' } },
        { collection: COLL, recordId: id, operation: 'delete', payload: {} },
      ]),
    ).toEqual([
      expect.objectContaining({ recordId: id, status: 'conflict' }),
      expect.objectContaining({ recordId: id, status: 'conflict' }),
    ]);
    expect(await revisions(id)).toEqual([]);
    expect(eventsFor(id)).toEqual([]);
  });
});
