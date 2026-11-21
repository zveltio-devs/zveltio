/**
 * `zveltio rotate-keys` (ADR 0059 decision 2 and its 2026-11-21 amendment).
 *
 * Rewrites every field value the engine sealed so that it sits under the
 * CURRENT field key as an `enc:v2:` envelope bound to where it lives: an
 * `enc:v1:` value (unbound) is resealed bound, a v2 value under an older key is
 * resealed under the current one. Then reports what is left under each key id,
 * so the operator knows when an old key can leave `FIELD_ENCRYPTION_KEYS`.
 *
 * Engine-owned storage only (ADR 0059 order of work, step 2):
 *   - every `encrypted` or `secret` column of every collection, per tenant;
 *   - the copies of those fields in `zv_revisions.data` / `.delta`;
 *   - webhook signing secrets (`zvd_webhooks.secret`, `$webhooks`);
 *   - the S3 secret of the storage setting (`zv_settings`, `$settings`).
 * Extension-sealed values (`ctx.internals.encryptSecret`, the mail keyring) are
 * step 3: their readers name no row, so they cannot move to v2.
 *
 * Fail closed: a value no listed key opens is reported by location, never
 * rewritten or dropped. Idempotent: a value already under the current key as v2
 * is left as it is, so a re-run after an interruption only does what is left;
 * each batch commits on its own. A write only lands while the stored value is
 * still the one read, so a row a live engine changed in between is counted and
 * left to the next run. `dryRun` reads and reports, and writes nothing.
 */

import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { DDLManager, normalizeFields } from './data/index.js';
import {
  type FieldAad,
  fieldKeyId,
  isFieldEnvelope,
  isBoundFieldValue,
  keyList,
  openFieldValue,
  sealField,
} from './security/index.js';
import { webhookSecretAad } from './webhooks.js';
import { S3_SECRET_AAD, STORAGE_SETTINGS_KEY } from '../routes/admin/storage-routes.js';

export interface RotateKeysOptions {
  /** Read and report; write nothing. */
  dryRun?: boolean;
  /** Rows read and written per transaction. */
  batchSize?: number;
}

export interface RotateKeysReport {
  dryRun: boolean;
  /** The id of the key every value is rewritten under. */
  currentKeyId: string;
  /** Values rewritten (with `dryRun`: that would be). */
  rewritten: number;
  /** Values under each key id after the run (with `dryRun`: as they are now). */
  left: Record<string, number>;
  /** Of those, values still `enc:v1:` (unbound). */
  unbound: number;
  /** Values a live write changed between the read and the rewrite: run again. */
  changed: number;
  /** Values no listed key opens where they live. Never rewritten. */
  unopenable: Array<{ store: string; tenant: string; record: string; field: string }>;
}

const FIRST_ID = '00000000-0000-0000-0000-000000000000';

/** Run `fn` as the engine in `tenant`: the policies' WITH CHECK is the own node. */
function asTenant<T>(db: Database, tenant: string, fn: (trx: Database) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('zveltio.current_tenant', ${tenant}, true),
                     set_config('zveltio.visible_tenants', ${tenant}, true)`.execute(trx);
    return fn(trx);
  });
}

export async function rotateKeys(
  db: Database,
  opts: RotateKeysOptions = {},
): Promise<RotateKeysReport> {
  const list = keyList('field');
  if (!list.currentOk) {
    throw new Error(
      `${list.source} has no usable current key: rotate-keys writes under it, so it refuses to start.`,
    );
  }
  const dryRun = opts.dryRun === true;
  const batch = Math.max(1, opts.batchSize ?? 500);
  const report: RotateKeysReport = {
    dryRun,
    currentKeyId: fieldKeyId(list.keys[0]!),
    rewritten: 0,
    left: {},
    unbound: 0,
    changed: 0,
    unopenable: [],
  };
  const count = (kid: string, unbound: boolean) => {
    report.left[kid] = (report.left[kid] ?? 0) + 1;
    if (unbound) report.unbound++;
  };

  /**
   * The value `v` should be stored as, or null when it stays: already current
   * and bound, not field ciphertext, or not openable (reported).
   */
  const next = async (v: unknown, aad: FieldAad, store: string): Promise<string | null> => {
    if (!isFieldEnvelope(v)) return null;
    const opened = await openFieldValue(v, aad);
    if (!opened) {
      report.unopenable.push({ store, tenant: aad.tenant, record: aad.record, field: aad.field });
      return null;
    }
    const bound = isBoundFieldValue(v);
    if (opened.current && bound) {
      count(opened.keyId, false);
      return null;
    }
    if (dryRun) {
      count(opened.keyId, !bound);
      report.rewritten++;
      return null;
    }
    return sealField(opened.plaintext, aad);
  };
  /** Book the outcome of `planned` rewrites of which `landed` were written. */
  const landed = (planned: number, written: number) => {
    report.rewritten += written;
    report.changed += planned - written;
    report.left[report.currentKeyId] = (report.left[report.currentKeyId] ?? 0) + written;
  };

  const tenants = (await sql<{ id: string }>`SELECT id::text AS id FROM zv_tenants ORDER BY id`.execute(db))
    .rows.map((r) => r.id);

  // ── Collections: every `encrypted` / `secret` column ────────────────────────
  const names = (await db.selectFrom('zvd_collections').select('name').execute()).map(
    (r) => r.name as string,
  );
  const sealedByCollection = new Map<string, string[]>();
  for (const name of names) {
    const def = await DDLManager.getCollection(db, name);
    const sealed = normalizeFields(def)
      .filter((f) => f.encrypted || f.type === 'secret')
      .map((f) => f.name);
    if (sealed.length > 0) sealedByCollection.set(name, sealed);
  }

  for (const [collection, fields] of sealedByCollection) {
    const table = DDLManager.getTableName(collection);
    const present = await sql<{ c: string }>`
      SELECT column_name AS c FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ${table}`.execute(db);
    const columns = new Set(present.rows.map((r) => r.c));
    for (const field of fields.filter((f) => columns.has(f))) {
      const t = sql.id(table);
      const col = sql.id(field);
      const store = `${table}.${field}`;
      for (const tenant of tenants) {
        let after = FIRST_ID;
        for (;;) {
          const more = await asTenant(db, tenant, async (trx) => {
            const rows = (
              await sql<{ id: string; v: string }>`
                SELECT id::text AS id, ${col} AS v FROM ${t}
                 WHERE tenant_id = ${tenant}::uuid AND ${col} IS NOT NULL AND id > ${after}::uuid
                 ORDER BY id LIMIT ${batch}`.execute(trx)
            ).rows;
            const writes: Array<{ id: string; old: string; new: string }> = [];
            for (const { id, v } of rows) {
              const out = await next(v, { tenant, collection, field, record: id }, store);
              if (out !== null) writes.push({ id, old: v, new: out });
            }
            if (writes.length > 0) {
              const done = await sql`
                UPDATE ${t} SET ${col} = w.new
                  FROM jsonb_to_recordset(${JSON.stringify(writes)}::text::jsonb)
                       AS w(id uuid, old text, new text)
                 WHERE ${t}.id = w.id AND ${t}.tenant_id = ${tenant}::uuid AND ${t}.${col} = w.old
                RETURNING ${t}.id`.execute(trx);
              landed(writes.length, done.rows.length);
            }
            if (rows.length > 0) after = rows[rows.length - 1]!.id;
            return rows.length === batch;
          });
          if (!more) break;
        }
      }
    }
  }

  // ── zv_revisions: the stored copies of those fields ─────────────────────────
  // Bound as the live row is, to the snapshot's own tenant and id (the readers
  // open a copy the same way); a delta carries neither and takes the revision's.
  for (const [collection, fields] of sealedByCollection) {
    const store = 'zv_revisions';
    for (const tenant of tenants) {
      let after = FIRST_ID;
      for (;;) {
        const more = await asTenant(db, tenant, async (trx) => {
          const rows = (
            // As text: compared byte for byte on the way back, and a copy stored
            // as a jsonb string (migration 009's shape) is parsed here, not by the driver.
            await sql<{ id: string; record_id: string; data: string; delta: string | null }>`
              SELECT id::text AS id, record_id, data::text AS data, delta::text AS delta
                FROM zv_revisions
               WHERE tenant_id = ${tenant}::uuid AND collection = ${collection}
                 AND id > ${after}::uuid
               ORDER BY id LIMIT ${batch}`.execute(trx)
          ).rows;
          const writes: Array<{
            id: string;
            data: unknown;
            delta: unknown;
            od: string;
            ol: string | null;
            n: number;
          }> = [];
          for (const row of rows) {
            const data = asObject(row.data);
            const where = {
              tenant: typeof data?.tenant_id === 'string' ? data.tenant_id : tenant,
              record: typeof data?.id === 'string' ? data.id : row.record_id,
            };
            let touched = 0;
            const rewrite = async (o: Record<string, unknown> | null) => {
              if (!o) return o;
              const copy = { ...o };
              for (const field of fields) {
                const out = await next(copy[field], { ...where, collection, field }, store);
                if (out !== null) {
                  copy[field] = out;
                  touched++;
                }
              }
              return copy;
            };
            const nextData = await rewrite(data);
            const nextDelta = await rewrite(asObject(row.delta));
            if (touched > 0) {
              writes.push({
                id: row.id,
                data: nextData ?? JSON.parse(row.data),
                delta: nextDelta ?? (row.delta === null ? null : JSON.parse(row.delta)),
                od: row.data,
                ol: row.delta,
                n: touched,
              });
            }
          }
          if (writes.length > 0) {
            const done = await sql`
              UPDATE zv_revisions r SET data = w.data, delta = w.delta
                FROM jsonb_to_recordset(${JSON.stringify(writes)}::text::jsonb)
                     AS w(id uuid, data jsonb, delta jsonb, od text, ol text)
               WHERE r.id = w.id AND r.tenant_id = ${tenant}::uuid
                 AND r.data::text = w.od AND r.delta::text IS NOT DISTINCT FROM w.ol
              RETURNING r.id::text AS id`.execute(trx);
            const hit = new Set((done.rows as Array<{ id: string }>).map((r) => r.id));
            const values = (only: boolean) =>
              writes.filter((w) => !only || hit.has(w.id)).reduce((n, w) => n + w.n, 0);
            landed(values(false), values(true));
          }
          if (rows.length > 0) after = rows[rows.length - 1]!.id;
          return rows.length === batch;
        });
        if (!more) break;
      }
    }
  }

  // ── Webhook signing secrets ─────────────────────────────────────────────────
  for (const tenant of tenants) {
    await asTenant(db, tenant, async (trx) => {
      const rows = (
        await sql<{ id: string; v: string }>`
          SELECT id::text AS id, secret AS v FROM zvd_webhooks
           WHERE tenant_id = ${tenant}::uuid AND secret IS NOT NULL`.execute(trx)
      ).rows;
      let planned = 0;
      let written = 0;
      for (const { id, v } of rows) {
        const out = await next(v, webhookSecretAad(tenant, id), 'zvd_webhooks.secret');
        if (out === null) continue;
        planned++;
        const done = await sql`
          UPDATE zvd_webhooks SET secret = ${out}
           WHERE id = ${id}::uuid AND tenant_id = ${tenant}::uuid AND secret = ${v}
          RETURNING id`.execute(trx);
        written += done.rows.length;
      }
      if (planned > 0) landed(planned, written);
    });
  }

  // ── The storage setting's S3 secret (instance-wide) ─────────────────────────
  await db.transaction().execute(async (trx) => {
    const row = (
      await sql<{ raw: string; wrapped: boolean }>`
        SELECT value::text AS raw, jsonb_typeof(value) = 'string' AS wrapped
          FROM zv_settings WHERE key = ${STORAGE_SETTINGS_KEY}`.execute(trx)
    ).rows[0];
    if (!row) return;
    const conf = asObject(row.raw);
    const s3 = conf?.s3 as Record<string, unknown> | undefined;
    if (!conf || !s3) return;
    const out = await next(s3.secretKey, S3_SECRET_AAD, 'zv_settings.storage_config');
    if (out === null) return;
    // Written back in the shape it was read in (the route stores a jsonb string).
    const updated = { ...conf, s3: { ...s3, secretKey: out } };
    const json = JSON.stringify(updated);
    const done = await sql`
      UPDATE zv_settings
         SET value = ${row.wrapped ? sql`to_jsonb(${json}::text)` : sql`${json}::text::jsonb`}
       WHERE key = ${STORAGE_SETTINGS_KEY} AND value::text = ${row.raw}
      RETURNING key`.execute(trx);
    landed(1, done.rows.length);
  });

  return report;
}

/** JSON text of a jsonb copy as an object; one stored as a jsonb string (migration 009's shape) is parsed again. */
function asObject(text: string | null): Record<string, unknown> | null {
  let o: unknown = text;
  for (let i = 0; i < 2 && typeof o === 'string'; i++) {
    try {
      o = JSON.parse(o);
    } catch {
      return null;
    }
  }
  return o !== null && typeof o === 'object' && !Array.isArray(o)
    ? (o as Record<string, unknown>)
    : null;
}
