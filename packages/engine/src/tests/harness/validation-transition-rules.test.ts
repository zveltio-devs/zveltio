/**
 * `transition` validation rules: CEL over the value being written (`value`) and
 * the one stored before it (`previous`, `null` on create).
 *
 * The rule here is a small state machine on `status`: a record starts as
 * `draft`, a draft may become `sent` or `cancelled`, and nothing else moves.
 * Create, PATCH, PUT and bulk PATCH all judge it against the stored row; a path
 * that never reads the stored row (sync, ctx.db updates) refuses a write that
 * touches the field rather than let it through unjudged.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, processInput } from '../../lib/data/index.js';
import { invalidateRulesCache } from '../../lib/validation-engine.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `htransition_${Date.now()}`;
const RULE =
  "previous == null ? value == 'draft' : " +
  "(previous == 'draft' ? value in ['sent', 'cancelled'] : value == previous)";

d('transition rules', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const send = (method: string, path: string, body: unknown) =>
    app.request(`/api/data/${COLLECTION}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  const create = async (status: string) => {
    const res = await send('POST', '', { title: 't', status });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string; data?: { id: string } };
    return (body.id ?? body.data?.id) as string;
  };
  const stored = async (id: string) =>
    (
      await sql<{
        status: string;
      }>`SELECT status FROM ${sql.table(`zvd_${COLLECTION}`)} WHERE id = ${id}`.execute(db)
    ).rows[0]?.status;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'status', type: 'text', required: false, unique: false, indexed: false },
        {
          name: 'secret',
          type: 'text',
          required: false,
          unique: false,
          indexed: false,
          encrypted: true,
        },
      ],
    } as never);
    await sql`
      INSERT INTO zv_validation_rules
        (collection, field_name, rule_type, rule_config, error_message, is_active)
      VALUES (${COLLECTION}, 'status', 'transition', ${JSON.stringify({ expression: RULE })}::jsonb,
              'Status cannot move that way', TRUE),
             (${COLLECTION}, 'secret', 'transition', ${JSON.stringify({ expression: 'value != previous' })}::jsonb,
              'Secret cannot stay the same', TRUE)`.execute(db);
    invalidateRulesCache(COLLECTION);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${COLLECTION}`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
  });

  it('judges a create against no previous value', async () => {
    expect((await send('POST', '', { status: 'sent' })).status).toBe(422);
    expect(await create('draft')).toBeString();
  });

  it('PATCH admits an allowed move and refuses a forbidden one', async () => {
    const id = await create('draft');
    expect((await send('PATCH', `/${id}`, { status: 'sent' })).status).toBe(200);
    const back = await send('PATCH', `/${id}`, { status: 'draft' });
    expect(back.status).toBe(422);
    expect(JSON.stringify(await back.json())).toContain('Status cannot move that way');
    expect(await stored(id)).toBe('sent');
    // A write that does not touch the field is not judged by its rule.
    expect((await send('PATCH', `/${id}`, { title: 'renamed' })).status).toBe(200);
  });

  it('PUT judges the stored value too', async () => {
    const id = await create('draft');
    expect((await send('PATCH', `/${id}`, { status: 'cancelled' })).status).toBe(200);
    expect((await send('PUT', `/${id}`, { title: 't', status: 'sent' })).status).toBe(422);
    expect(await stored(id)).toBe('cancelled');
  });

  it('bulk PATCH judges each row against its own stored value', async () => {
    const a = await create('draft');
    const b = await create('draft');
    expect((await send('PATCH', `/${b}`, { status: 'sent' })).status).toBe(200);
    await send('PATCH', '/bulk', {
      records: [
        { id: a, status: 'sent' },
        { id: b, status: 'cancelled' },
      ],
    });
    expect(await stored(a)).toBe('sent');
    expect(await stored(b)).toBe('sent');
  });

  it('a path that reads no stored row refuses a write touching the field', async () => {
    const def = await DDLManager.getCollection(db, COLLECTION);
    const { errors } = await processInput({ status: 'sent' }, def, true);
    expect(errors.join()).toContain('cannot be evaluated');
    expect((await processInput({ title: 'x' }, def, true)).errors).toEqual([]);
  });

  it('refuses a transition rule on an encrypted field, whose values are ciphertext', async () => {
    // `value != previous` would pass every ciphertext pair, judged naively.
    expect((await send('POST', '', { status: 'draft', secret: 's' })).status).toBe(422);
    const id = await create('draft');
    expect((await send('PATCH', `/${id}`, { secret: 's' })).status).toBe(422);
  });
});
