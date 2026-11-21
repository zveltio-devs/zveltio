/**
 * `zveltio rotate-keys` (ADR 0059 decision 2, amendment 2026-11-21).
 *
 * Planted under the old key K0: an `enc:v1:` value, an `enc:v2:` value, a
 * `secret`, a revision copy (data and delta), a webhook secret and the storage
 * setting's S3 secret. Planted beside them, two values no listed key opens: one
 * under a key the operator never listed, and a v2 value copied from another row.
 * Then the list becomes K1,K0 and the command runs: every openable value ends
 * up `enc:v2:` under K1 bound to where it lives, the two others are reported and
 * left byte for byte, and K0 can then leave the list without losing a value.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  DDLManager,
  decryptField,
  encryptField,
  encryptFieldUnbound,
} from '../../lib/data/index.js';
import { fieldKeyId } from '../../lib/security/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { webhookSecretAad } from '../../lib/webhooks.js';
import { S3_SECRET_AAD } from '../../routes/admin/storage-routes.js';
import { rotateKeys } from '../../lib/rotate-keys.js';
import {
  asDefaultTenant,
  createGodSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() && process.env.FIELD_ENCRYPTION_KEY ? describe : describe.skip;
const COLLECTION = `hrotate_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const K0 = process.env.FIELD_ENCRYPTION_KEY ?? '';
const K1 = '1'.repeat(64);
const K9 = '9'.repeat(64);
const id = () => crypto.randomUUID();
const R = { v1: id(), v2: id(), v1k1: id(), foreign: id(), copied: id(), secret: id() };
const HOOK = id();
const REV = id();

d('rotate-keys (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let savedSettings: string | undefined;
  const aad = (record: string, field = 'note') => ({
    tenant: DEFAULT_TENANT_ID,
    collection: COLLECTION,
    field,
    record,
  });
  const read = async () => {
    const rows = await asDefaultTenant(
      db,
      sql<{ id: string; note: string | null; token: string | null }>`
        SELECT id::text AS id, note, token FROM ${sql.table(TABLE)}`,
    );
    return new Map(rows.rows.map((r) => [r.id, r]));
  };
  const revision = async () =>
    (
      await asDefaultTenant(
        db,
        sql<{ data: Record<string, string>; delta: Record<string, string> }>`
          SELECT data, delta FROM zv_revisions WHERE id = ${REV}::uuid`,
      )
    ).rows[0]!;
  const hookSecret = async () =>
    (
      await asDefaultTenant(
        db,
        sql<{ secret: string }>`SELECT secret FROM zvd_webhooks WHERE id = ${HOOK}::uuid`,
      )
    ).rows[0]!.secret;
  const s3Secret = async () => {
    const row = (
      await sql<{ t: string }>`
        SELECT CASE WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}' ELSE value::text END AS t
          FROM zv_settings WHERE key = 'storage_config'`.execute(db)
    ).rows[0]!;
    return JSON.parse(row.t).s3.secretKey as string;
  };
  const under = (v: string | null | undefined, key: string) =>
    typeof v === 'string' && v.startsWith(`enc:v2:${fieldKeyId(key)}:`);
  const mine = (r: Awaited<ReturnType<typeof rotateKeys>>) =>
    r.unopenable
      .filter((u) => u.store === `${TABLE}.note`)
      .map((u) => u.record)
      .sort();

  let planted: Awaited<ReturnType<typeof read>>;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        {
          name: 'note',
          type: 'text',
          required: false,
          unique: false,
          indexed: false,
          encrypted: true,
        },
        { name: 'token', type: 'secret', required: false, unique: false, indexed: false },
      ],
    } as never);
    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${TABLE}`.execute(db);
      if (seen.rows[0]!.n > 0) break;
      await Bun.sleep(100);
    }

    // Under K0, the only key so far.
    const v1 = await encryptFieldUnbound('plain-v1');
    const v2 = await encryptField('plain-v2', aad(R.v2));
    const token = await encryptFieldUnbound('plain-token');
    const hook = await encryptFieldUnbound('hook-secret');
    const s3 = await encryptFieldUnbound('s3-secret');
    // A key the operator never listed: nothing can open it.
    process.env.FIELD_ENCRYPTION_KEY = K9;
    const foreign = await encryptFieldUnbound('lost');
    // Already under the new key, but unbound: still rewritten, as v2.
    process.env.FIELD_ENCRYPTION_KEY = K1;
    const v1k1 = await encryptFieldUnbound('plain-v1k1');
    process.env.FIELD_ENCRYPTION_KEY = K0;

    await asDefaultTenant(db, async (trx) => {
      const t = sql.table(TABLE);
      const ins = (rid: string, note: string | null, tok: string | null) =>
        sql`INSERT INTO ${t} (id, tenant_id, note, token)
            VALUES (${rid}::uuid, ${DEFAULT_TENANT_ID}::uuid, ${note}, ${tok})`.execute(trx);
      await ins(R.v1, v1, null);
      await ins(R.v2, v2, null);
      await ins(R.v1k1, v1k1, null);
      await ins(R.foreign, foreign, null);
      // R.v2's v2 value copied here: bound to R.v2, it opens nowhere else.
      await ins(R.copied, v2, null);
      await ins(R.secret, null, token);
      await trx
        .insertInto('zv_revisions')
        .values({
          id: REV,
          collection: COLLECTION,
          record_id: R.v1,
          action: 'update',
          data: { id: R.v1, tenant_id: DEFAULT_TENANT_ID, note: v1 },
          delta: { note: v1 },
          tenant_id: DEFAULT_TENANT_ID,
        } as never)
        .execute();
      await sql`INSERT INTO zvd_webhooks (id, tenant_id, name, url, events, secret)
                VALUES (${HOOK}::uuid, ${DEFAULT_TENANT_ID}::uuid, 'rk', 'https://example.com/h',
                        ARRAY['insert'], ${hook})`.execute(trx);
    });
    savedSettings = (
      await sql<{
        raw: string;
      }>`SELECT value::text AS raw FROM zv_settings WHERE key = 'storage_config'`.execute(db)
    ).rows[0]?.raw;
    // The shape the storage route writes: a jsonb string holding the JSON.
    const conf = JSON.stringify({ driver: 's3', s3: { bucket: 'b', secretKey: s3 } });
    await sql`INSERT INTO zv_settings (key, value) VALUES ('storage_config', to_jsonb(${conf}::text))
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(db);
    planted = await read();
    // The rotation: K1 becomes current, K0 stays readable.
    process.env.FIELD_ENCRYPTION_KEYS = `${K1},${K0}`;
  }, 60_000);

  afterAll(async () => {
    delete process.env.FIELD_ENCRYPTION_KEYS;
    process.env.FIELD_ENCRYPTION_KEY = K0;
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
    await asDefaultTenant(db, async (trx) => {
      await trx.deleteFrom('zv_revisions').where('collection', '=', COLLECTION).execute();
      await trx.deleteFrom('zvd_webhooks').where('id', '=', HOOK).execute();
    }).catch(() => {});
    if (savedSettings === undefined) {
      await sql`DELETE FROM zv_settings WHERE key = 'storage_config'`.execute(db).catch(() => {});
    } else {
      await sql`UPDATE zv_settings SET value = ${savedSettings}::text::jsonb
                WHERE key = 'storage_config'`
        .execute(db)
        .catch(() => {});
    }
  });

  it('--dry-run reports what it would rewrite and writes nothing', async () => {
    const r = await rotateKeys(db, { dryRun: true });
    expect(r.currentKeyId).toBe(fieldKeyId(K1));
    expect(mine(r)).toEqual([R.copied, R.foreign].sort());
    // v1 (K0 and K1), v2, secret, revision data + delta, webhook, S3: eight at least.
    expect(r.rewritten).toBeGreaterThanOrEqual(8);
    expect(r.unbound).toBeGreaterThanOrEqual(7);
    expect(r.left[fieldKeyId(K0)]).toBeGreaterThanOrEqual(7);
    expect(await read()).toEqual(planted);
    expect((await revision()).delta.note.startsWith('enc:v1:')).toBe(true);
  });

  it('rewrites every openable value under the current key, bound to where it lives', async () => {
    const r = await rotateKeys(db, { batchSize: 2 });
    const now = await read();
    for (const rid of [R.v1, R.v2, R.v1k1]) expect(under(now.get(rid)!.note, K1)).toBe(true);
    expect(await decryptField(now.get(R.v1k1)!.note!, aad(R.v1k1))).toBe('plain-v1k1');
    expect(await decryptField(now.get(R.v1)!.note!, aad(R.v1))).toBe('plain-v1');
    expect(await decryptField(now.get(R.v2)!.note!, aad(R.v2))).toBe('plain-v2');
    expect(under(now.get(R.secret)!.token, K1)).toBe(true);
    expect(await decryptField(now.get(R.secret)!.token!, aad(R.secret, 'token'))).toBe(
      'plain-token',
    );

    const rev = await revision();
    expect(under(rev.data.note, K1) && under(rev.delta.note, K1)).toBe(true);
    expect(await decryptField(rev.delta.note, aad(R.v1))).toBe('plain-v1');
    expect(under(await hookSecret(), K1)).toBe(true);
    expect(await decryptField(await hookSecret(), webhookSecretAad(DEFAULT_TENANT_ID, HOOK))).toBe(
      'hook-secret',
    );
    expect(under(await s3Secret(), K1)).toBe(true);
    expect(await decryptField(await s3Secret(), S3_SECRET_AAD)).toBe('s3-secret');

    // Fail closed: reported, and left byte for byte.
    expect(mine(r)).toEqual([R.copied, R.foreign].sort());
    expect(now.get(R.foreign)!.note).toBe(planted.get(R.foreign)!.note);
    expect(now.get(R.copied)!.note).toBe(planted.get(R.copied)!.note);
    expect(r.left[fieldKeyId(K0)]).toBeUndefined();
    expect(r.unbound).toBe(0);
    expect(r.changed).toBe(0);
  });

  it('a second run rewrites nothing', async () => {
    const before = await read();
    const r = await rotateKeys(db);
    expect(r.rewritten).toBe(0);
    expect(mine(r)).toEqual([R.copied, R.foreign].sort());
    expect(await read()).toEqual(before);
  });

  it('K0 then leaves the list: records and revisions still read in the clear', async () => {
    process.env.FIELD_ENCRYPTION_KEYS = K1;
    process.env.FIELD_ENCRYPTION_KEY = K1;
    try {
      const get = await app.request(`/api/data/${COLLECTION}/${R.v1}`, { headers: { cookie } });
      expect(((await get.json()) as { note?: string }).note).toBe('plain-v1');
      const revs = await app.request(`/api/revisions?collection=${COLLECTION}&record_id=${R.v1}`, {
        headers: { cookie },
      });
      const body = JSON.stringify(await revs.json());
      expect(body).toContain('plain-v1');
      expect(body).not.toContain('enc:v');
    } finally {
      process.env.FIELD_ENCRYPTION_KEYS = `${K1},${K0}`;
      process.env.FIELD_ENCRYPTION_KEY = K0;
    }
  });
});
