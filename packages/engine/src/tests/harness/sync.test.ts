/**
 * Phase C — SDK sync routes driven through the in-process app.
 *
 * Exercises routes/sync.ts push/pull validation and a happy-path create on a
 * harness-provisioned collection. No separate engine process required.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const COLLECTION = `hsync_${Date.now()}`;

d('sync routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  const json = (path: string, body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'secret', type: 'password', required: false, unique: false, indexed: false },
        {
          name: 'api_key',
          type: 'text',
          required: false,
          unique: false,
          indexed: false,
          encrypted: true,
        },
      ],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DELETE FROM "zvd_${COLLECTION}"`)
      .execute(db)
      .catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('rejects unauthenticated push', async () => {
    const res = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid push body', async () => {
    const res = await app.request('/api/sync/push', json('/api/sync/push', {}));
    expect(res.status).toBe(400);
  });

  it('push create on a real collection returns ok', async () => {
    const recordId = crypto.randomUUID();
    const res = await app.request(
      '/api/sync/push',
      json('/api/sync/push', {
        operations: [
          {
            collection: COLLECTION,
            recordId,
            operation: 'create',
            payload: { title: 'synced' },
            clientTimestamp: Date.now(),
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { recordId: string; status: string }[] };
    expect(body.results[0]?.status).toBe('ok');
    expect(body.results[0]?.recordId).toBe(recordId);
  });

  it('hashes a password field pushed by a client', async () => {
    // Sanitizing a push stopped at the column allowlist — it blocked `role`
    // and `tenant_id`, then handed the values straight to the INSERT. So no
    // field type's `deserialize` ran, and `password`'s deserialize IS the
    // hashing step: a password written offline synced up as plaintext.
    const recordId = crypto.randomUUID();
    const plaintext = 'correct horse battery staple';
    const res = await app.request(
      '/api/sync/push',
      json('/api/sync/push', {
        operations: [
          {
            collection: COLLECTION,
            recordId,
            operation: 'create',
            payload: { title: 'pw', secret: plaintext },
            clientTimestamp: Date.now(),
          },
        ],
      }),
    );
    expect(res.status).toBe(200);

    const rows = (await sql
      .raw(`SELECT secret FROM "zvd_${COLLECTION}" WHERE id = '${recordId}'`)
      .execute(db)) as { rows: { secret: string }[] };
    expect(rows.rows.length).toBe(1);
    const stored = rows.rows[0]!.secret;
    expect(stored).not.toBe(plaintext);
    expect(await Bun.password.verify(plaintext, stored)).toBe(true);
  });

  it('a pushed create leaves a revision, like a bulk write does', async () => {
    // A sync push landed rows in the table and nowhere else: no revision (so
    // `?as_of=` could not see them), no webhook, no realtime nudge for the
    // colleague looking at the same list.
    const recordId = crypto.randomUUID();
    await app.request(
      '/api/sync/push',
      json('/api/sync/push', {
        operations: [
          {
            collection: COLLECTION,
            recordId,
            operation: 'create',
            payload: { title: 'revsync' },
            clientTimestamp: Date.now(),
          },
        ],
      }),
    );

    // afterWrite is fire-and-forget, as it is in the bulk handler.
    await new Promise((r) => setTimeout(r, 250));
    const revs = await db
      .selectFrom('zv_revisions')
      .select('action')
      .where('record_id', '=', recordId)
      .execute();
    expect(revs.length).toBeGreaterThan(0);
    expect(revs[0]!.action).toBe('create');
  });

  it('pull decrypts an encrypted field instead of shipping ciphertext', async () => {
    // The offline client has no key. Pull applied row policies and deleted
    // hidden columns and stopped there, so a field marked `encrypted: true`
    // arrived as `enc:v1:…` — unreadable on the device, while `GET /api/data`
    // returned it in the clear. Two read paths, two answers.
    const recordId = crypto.randomUUID();
    const secret = 'sk_live_sync_pull_probe';
    await app.request(
      '/api/sync/push',
      json('/api/sync/push', {
        operations: [
          {
            collection: COLLECTION,
            recordId,
            operation: 'create',
            payload: { title: 'crypt', api_key: secret },
            clientTimestamp: Date.now(),
          },
        ],
      }),
    );

    // Stored encrypted — the push path's job, asserted so a failure here is
    // unambiguous about which half broke.
    const stored = (await sql
      .raw(`SELECT api_key FROM "zvd_${COLLECTION}" WHERE id = '${recordId}'`)
      .execute(db)) as { rows: { api_key: string }[] };
    expect(stored.rows[0]!.api_key.startsWith('enc:v1:')).toBe(true);

    const res = await app.request(
      '/api/sync/pull',
      json('/api/sync/pull', { collections: [COLLECTION], since: 0 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changes?: { id: string; data: Record<string, unknown> }[];
    };
    const mine = (body.changes ?? []).find((c) => c.id === recordId);
    expect(mine).toBeDefined();
    expect(mine!.data.api_key).toBe(secret);
  });

  it('pull returns changes for the collection', async () => {
    const res = await app.request(
      '/api/sync/pull',
      json('/api/sync/pull', {
        collections: [COLLECTION],
        since: 0,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changes: unknown[]; serverTimestamp: number };
    expect(Array.isArray(body.changes)).toBe(true);
    expect(typeof body.serverTimestamp).toBe('number');
  });

  it('rejects system table writes via push', async () => {
    const res = await app.request(
      '/api/sync/push',
      json('/api/sync/push', {
        operations: [
          {
            collection: 'user',
            recordId: crypto.randomUUID(),
            operation: 'create',
            payload: { email: 'nope@test.local' },
            clientTimestamp: Date.now(),
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { status: string; error?: string }[] };
    expect(body.results[0]?.status).toBe('error');
  });
});
