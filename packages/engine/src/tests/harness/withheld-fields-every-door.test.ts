/**
 * A field REST never serves is not served by any other door either.
 *
 * `GET /api/data` drops a `password` field (its type serializes to nothing) and
 * decrypts an `encrypted: true` one. Every other payload of a record shaped it
 * with column permissions only (`ReadScope.shape`), so the argon2 hash and the
 * `enc:v1:` ciphertext reached a WS socket, an SSE stream, `?as_of=`, the
 * revision list and a webhook; and a filter on the password field read the
 * hash back one character at a time through the row count.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { websocketHandler } from '../../routes/ws.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() && process.env.FIELD_ENCRYPTION_KEY ? describe : describe.skip;
const COLLECTION = `hwithheld_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const SECRET = 'iban-RO49-AAAA-1B31-0075-9384-0000';

/**
 * Neither the hash nor the ciphertext, anywhere in the payload. A stream or a
 * webhook drops the encrypted field; a REST read of history decrypts it, as the
 * live read does.
 */
function expectWithheld(payload: unknown, encrypted: 'dropped' | 'decrypted' = 'dropped') {
  const s = JSON.stringify(payload);
  expect(s).toContain('visible-label');
  expect(s).not.toContain('$argon2');
  expect(s).not.toContain('enc:v1:');
  // Concatenates every text field, column-hidden ones included.
  expect(s).not.toContain('search_text');
  if (encrypted === 'dropped') expect(s).not.toContain(SECRET);
  else expect(s).toContain(SECRET);
}

d('password and encrypted fields leave through no door (in-process)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let recordId = '';
  let webhookId = '';
  let originalFetch: typeof fetch;
  const wsSent: string[] = [];
  const sseDelivered: string[] = [];
  let ws: unknown;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  beforeAll(async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, text: async () => 'ok' }) as Response) as unknown as typeof fetch;

    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: false, unique: false, indexed: false },
        { name: 'pw', type: 'password', required: false, unique: false, indexed: false },
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
    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${TABLE}`.execute(db);
      if (seen.rows[0]!.n > 0) break;
      await Bun.sleep(100);
    }

    const wh = await app.request('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        name: `Withheld WH ${Date.now()}`,
        url: 'https://example.test/hook',
        events: ['insert'],
        collections: [COLLECTION],
      }),
    });
    const whBody = (await wh.json()) as { id?: string; webhook?: { id: string } };
    webhookId = whBody.id ?? whBody.webhook!.id;

    // A member who may read the collection, on both realtime doors.
    const member = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read', 'list'] }],
    });
    const data = await wsUpgradeData(app, { cookie: member.cookie });
    ws = { data: { ...data, id: `withheld_${Date.now()}` }, send: (p: string) => wsSent.push(p) };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [COLLECTION] }),
    );
    const res = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { cookie: member.cookie },
    });
    expect(res.status).toBe(200);
    reader = res.body!.getReader();
    await reader.read(); // `connected`
    const sub = [..._sseConnectionsForTests().get(member.userId)!].at(-1)!;
    const realWrite = sub.stream.writeSSE.bind(sub.stream);
    sub.stream.writeSSE = (msg: { data: string; event?: string }) => {
      sseDelivered.push(msg.data);
      return realWrite(msg);
    };
    wsSent.length = 0;

    const made = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ label: 'visible-label', pw: 'correct horse battery', secret: SECRET }),
    });
    expect(made.status).toBe(201);
    recordId = ((await made.json()) as { id: string }).id;
    for (let i = 0; i < 100 && (wsSent.length === 0 || sseDelivered.length === 0); i++)
      await Bun.sleep(10);
  }, 60_000);

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (ws) websocketHandler.close(ws as never);
    await reader?.cancel().catch(() => {});
    if (!db) return;
    if (webhookId) {
      await sql`DELETE FROM zvd_webhook_deliveries WHERE webhook_id = ${webhookId}`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zvd_webhooks WHERE id = ${webhookId}`.execute(db).catch(() => {});
    }
    await db
      .deleteFrom('zv_revisions')
      .where('collection', '=', COLLECTION)
      .execute()
      .catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  it('stores the hash and the ciphertext, which is the premise', async () => {
    const row = await sql<{ pw: string; secret: string }>`
      SELECT pw, secret FROM ${sql.table(TABLE)} WHERE id = ${recordId}::uuid`.execute(db);
    expect(row.rows[0]!.pw.startsWith('$argon2')).toBe(true);
    expect(row.rows[0]!.secret.startsWith('enc:v1:')).toBe(true);
  });

  it('REST GET serves neither, and decrypts the encrypted field', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      headers: { cookie: god },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pw).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('$argon2');
    expect(JSON.stringify(body)).toContain(SECRET);
  });

  it('the WS event carries neither', () => {
    const event = wsSent.map((p) => JSON.parse(p)).find((m) => m.type === 'event');
    expect(event).toBeDefined();
    expectWithheld(event);
  });

  it('the SSE event carries neither', () => {
    expect(sseDelivered.length).toBeGreaterThan(0);
    for (const p of sseDelivered) expectWithheld(JSON.parse(p));
  });

  it('?as_of= serves no hash and decrypts, single and list', async () => {
    const asOf = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    const one = await app.request(`/api/data/${COLLECTION}/${recordId}?as_of=${asOf}`, {
      headers: { cookie: god },
    });
    expect(one.status).toBe(200);
    expectWithheld(await one.json(), 'decrypted');
    const list = await app.request(`/api/data/${COLLECTION}?as_of=${asOf}`, {
      headers: { cookie: god },
    });
    expect(list.status).toBe(200);
    expectWithheld(await list.json(), 'decrypted');
  });

  it('the revision list serves no hash and decrypts', async () => {
    const res = await app.request(`/api/revisions?collection=${COLLECTION}`, {
      headers: { cookie: god },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revisions: unknown[] };
    expect(body.revisions.length).toBeGreaterThan(0);
    expectWithheld(body, 'decrypted');
  });

  it('a revert restores the encrypted value and leaves the password alone', async () => {
    const before = await sql<{ pw: string }>`
      SELECT pw FROM ${sql.table(TABLE)} WHERE id = ${recordId}::uuid`.execute(db);
    const patched = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ secret: 'changed' }),
    });
    expect(patched.status).toBe(200);
    const list = await app.request(`/api/revisions?collection=${COLLECTION}&action=create`, {
      headers: { cookie: god },
    });
    const created = ((await list.json()) as { revisions: { id: string }[] }).revisions[0]!;
    const reverted = await app.request(`/api/revisions/${created.id}/revert`, {
      method: 'POST',
      headers: { cookie: god },
    });
    expect(reverted.status).toBe(200);
    expectWithheld(await reverted.json(), 'decrypted');
    const after = await sql<{ pw: string; secret: string }>`
      SELECT pw, secret FROM ${sql.table(TABLE)} WHERE id = ${recordId}::uuid`.execute(db);
    expect(after.rows[0]!.pw).toBe(before.rows[0]!.pw);
    expect(after.rows[0]!.secret.startsWith('enc:v1:')).toBe(true);
    const live = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      headers: { cookie: god },
    });
    expect(((await live.json()) as { secret: string }).secret).toBe(SECRET);
  });

  it('the webhook payload carries neither', async () => {
    await Bun.sleep(300);
    const rows = await sql<{ payload: unknown }>`
      SELECT payload FROM zvd_webhook_deliveries WHERE webhook_id = ${webhookId}`.execute(db);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) expectWithheld(r.payload);
  });

  it('a filter or sort on the password field is refused, not a hash oracle', async () => {
    const filter = encodeURIComponent(JSON.stringify({ pw: { like: '$argon2%' } }));
    const res = await app.request(`/api/data/${COLLECTION}?filter=${filter}`, {
      headers: { cookie: god },
    });
    expect(res.status).toBe(400);
    const sorted = await app.request(`/api/data/${COLLECTION}?sort=pw`, {
      headers: { cookie: god },
    });
    expect(sorted.status).toBe(400);
  });
});
