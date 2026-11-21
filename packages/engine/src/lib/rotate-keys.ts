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
 * Ciphertext it does not rewrite is still COUNTED, per key id ("unvisited"):
 * rows of a tenant missing from `zv_tenants`, revision copies of a field that
 * is no longer sealed or of a row they do not name, webhook delivery payloads
 * and pg-boss job payloads. The verdict "older keys can leave the list" holds
 * only when nothing, visited or not, is under an older listed key — and when
 * every table could be read whole (`unchecked`).
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
import { DDLManager, normalizeFields, revisionRowOf } from './data/index.js';
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
  /**
   * Count the ciphertext of rows whose tenant is missing from `zv_tenants` even
   * when row-level security binds this role: lifts FORCE on each table for one
   * counting statement, under the table's ACCESS EXCLUSIVE lock.
   */
  checkMissingTenants?: boolean;
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
  unopenable: Array<{
    store: string;
    tenant: string;
    record: string;
    field: string;
    /** The key id a v2 value names (`none` for v1): bound elsewhere, it still keeps that key listed. */
    keyId: string;
  }>;
  /** Ciphertext not rewritten, per place (and why) and key id (`none`: no listed key opens it). */
  unvisited: Record<string, Record<string, number>>;
  /** Tables whose rows of missing tenants could not be read (see `checkMissingTenants`). */
  unchecked: string[];
  /** Whether no value, visited or not, is left under an older listed key. */
  oldKeysDroppable: boolean;
}

const FIRST_ID = '00000000-0000-0000-0000-000000000000';
/** Field envelopes inside JSON text; base64url and the key id need no escaping. */
const ENVELOPES = /enc:v1:[A-Za-z0-9_-]+|enc:v2:[0-9a-f]{8}:[A-Za-z0-9_-]+/g;
/** A row a tenant pass cannot see: no tenant, or one `zv_tenants` no longer holds. */
const MISSING_TENANT = sql.raw(
  '(tenant_id IS NULL OR NOT EXISTS (SELECT 1 FROM zv_tenants z WHERE z.id = tenant_id))',
);

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
    unvisited: {},
    unchecked: [],
    oldKeysDroppable: false,
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
      const keyId = v.startsWith('enc:v2:') ? v.split(':')[2]! : 'none';
      report.unopenable.push({
        store,
        tenant: aad.tenant,
        record: aad.record,
        field: aad.field,
        keyId,
      });
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
  /** Count every envelope in `text` under `where`: a v2 by the key id it names, a v1 by the key that opens it. */
  const tally = async (where: string, text: string | null | undefined) => {
    for (const env of text?.match(ENVELOPES) ?? []) {
      const kid = env.startsWith('enc:v2:')
        ? env.split(':')[2]!
        : ((await openFieldValue(env))?.keyId ?? 'none');
      report.unvisited[where] ??= {};
      const at = report.unvisited[where];
      at[kid] = (at[kid] ?? 0) + 1;
    }
  };

  // ── Rows of missing tenants: counted, never rewritten ───────────────────────
  // No tenant pass sees them (as in migration 084 and `intoSecretColumn`), and
  // under FORCE row-level security this role does not either, unless it is
  // exempt or lifts FORCE for the count.
  const exempt =
    (
      await sql<{ ok: boolean }>`
        SELECT rolsuper OR rolbypassrls AS ok FROM pg_roles WHERE rolname = current_user`.execute(
        db,
      )
    ).rows[0]?.ok === true;
  const countMissing = async (table: string, text: ReturnType<typeof sql.raw>) => {
    const t = sql.id(table);
    const forced =
      (
        await sql<{ f: boolean }>`
          SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = to_regclass(quote_ident(${table}))`.execute(
          db,
        )
      ).rows[0]?.f === true;
    if (forced && !exempt && !opts.checkMissingTenants) {
      report.unchecked.push(table);
      return;
    }
    const rows = await db.transaction().execute(async (trx) => {
      const lift = forced && !exempt;
      if (lift) {
        await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
        await sql`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`.execute(trx);
      }
      const found = await sql<{ v: string }>`
        SELECT ${text} AS v FROM ${t} WHERE ${MISSING_TENANT} AND ${text} LIKE '%enc:v_:%'`.execute(
        trx,
      );
      if (lift) await sql`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`.execute(trx);
      return found.rows;
    });
    for (const { v } of rows) await tally(`${table} (tenant missing)`, v);
  };

  const tenants = (
    await sql<{ id: string }>`SELECT id::text AS id FROM zv_tenants ORDER BY id`.execute(db)
  ).rows.map((r) => r.id);

  // ── Collections: every `encrypted` / `secret` column ────────────────────────
  const names = (await db.selectFrom('zvd_collections').select('name').execute()).map(
    (r) => r.name as string,
  );
  const sealedByCollection = new Map<string, Set<string>>();
  for (const name of names) {
    const def = await DDLManager.getCollection(db, name);
    const sealed = normalizeFields(def)
      .filter((f) => f.encrypted || f.type === 'secret')
      .map((f) => f.name);
    if (sealed.length > 0) sealedByCollection.set(name, new Set(sealed));
  }

  for (const [collection, fields] of sealedByCollection) {
    const table = DDLManager.getTableName(collection);
    const present = await sql<{ c: string }>`
      SELECT column_name AS c FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ${table}`.execute(db);
    const columns = new Set(present.rows.map((r) => r.c));
    for (const field of [...fields].filter((f) => columns.has(f))) {
      const t = sql.id(table);
      const col = sql.id(field);
      const store = `${table}.${field}`;
      // ponytail: one query per tenant per column even where a tenant has no row;
      // read the distinct tenant_ids first if installs ever hold thousands of tenants.
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
      await countMissing(table, sql.raw(`${quoteIdent(field)}::text`));
    }
  }

  // ── zv_revisions: the stored copies ─────────────────────────────────────────
  // A copy of a sealed field is bound to the row `revisionRowOf` names — the
  // one the revision read opens it under; its `delta` borrows the same row.
  // Ciphertext under any other key, or in a revision that names no row, is
  // counted, not rewritten.
  for (const tenant of tenants) {
    let after = FIRST_ID;
    for (;;) {
      const more = await asTenant(db, tenant, async (trx) => {
        // As text: compared byte for byte on the way back, and a copy stored
        // as a jsonb string (migration 009's shape) is parsed here, not by the driver.
        const rows = (
          await sql<{ id: string; collection: string; data: string; delta: string | null }>`
            SELECT id::text AS id, collection, data::text AS data, delta::text AS delta
              FROM zv_revisions
             WHERE tenant_id = ${tenant}::uuid AND id > ${after}::uuid
               AND (data::text LIKE '%enc:v_:%' OR delta::text LIKE '%enc:v_:%')
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
          const sealed = sealedByCollection.get(row.collection);
          const who = revisionRowOf(JSON.parse(row.data));
          let touched = 0;
          /** The copy rewritten, in the shape it was stored in (a jsonb string stays one). */
          const rewrite = async (text: string | null): Promise<unknown> => {
            const stored = text === null ? null : JSON.parse(text);
            const o = asObject(text);
            if (!o) {
              await tally(`zv_revisions.${row.collection} (not an object)`, text);
              return stored;
            }
            const copy = { ...o };
            for (const [field, v] of Object.entries(o)) {
              if (!isFieldEnvelope(v)) continue;
              if (!sealed?.has(field)) {
                await tally(`zv_revisions.${row.collection} (field not sealed)`, v);
                continue;
              }
              if (!who) {
                await tally(`zv_revisions.${row.collection} (names no row)`, v);
                continue;
              }
              const aad = {
                tenant: who.tenant_id,
                collection: row.collection,
                field,
                record: who.id,
              };
              const out = await next(v, aad, 'zv_revisions');
              if (out !== null) {
                copy[field] = out;
                touched++;
              }
            }
            return typeof stored === 'string' ? JSON.stringify(copy) : copy;
          };
          const data = await rewrite(row.data);
          const delta = await rewrite(row.delta);
          if (touched > 0) {
            writes.push({ id: row.id, data, delta, od: row.data, ol: row.delta, n: touched });
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
  await countMissing('zv_revisions', sql.raw(`concat(data::text, ' ', delta::text)`));

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
  await countMissing('zvd_webhooks', sql.raw('secret'));

  // ── Copies outside ADR 0059 step 2: counted ─────────────────────────────────
  // A delivery keeps what was sent and a job what it carries; since the outbound
  // copy drops sealed columns neither should hold ciphertext, but an older one
  // may. Nothing reads a sealed value back from them, so there is no row to
  // bind it to: counted, never rewritten.
  // ponytail: whole payloads read into memory per tenant; page them if a table
  // of old deliveries ever holds ciphertext by the million.
  for (const tenant of tenants) {
    await asTenant(db, tenant, async (trx) => {
      const rows = await sql<{ v: string }>`
        SELECT payload::text AS v FROM zvd_webhook_deliveries
         WHERE tenant_id = ${tenant}::uuid AND payload::text LIKE '%enc:v_:%'`.execute(trx);
      for (const { v } of rows.rows) await tally('zvd_webhook_deliveries.payload', v);
    });
  }
  await countMissing('zvd_webhook_deliveries', sql.raw('payload::text'));
  for (const table of ['pgboss.job', 'pgboss.archive']) {
    const exists = await sql<{
      ok: boolean;
    }>`SELECT to_regclass(${table}) IS NOT NULL AS ok`.execute(db);
    if (!exists.rows[0]?.ok) continue;
    const rows = await sql<{ v: string }>`
      SELECT data::text AS v FROM ${sql.raw(table)} WHERE data::text LIKE '%enc:v_:%'`.execute(db);
    for (const { v } of rows.rows) await tally(`${table}.data`, v);
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

  // The verdict: no value under an older LISTED key, visited, unopenable (a v2
  // bound elsewhere names its key) or not visited, and every table read whole. A v2 naming an unlisted key id, or `none`, is under no key
  // the list still holds, so it does not keep one there.
  const older = new Set(list.keys.slice(1).map(fieldKeyId));
  const kids = [
    ...Object.keys(report.left),
    ...Object.values(report.unvisited).flatMap((byKid) => Object.keys(byKid)),
    ...report.unopenable.map((u) => u.keyId),
  ];
  report.oldKeysDroppable =
    report.changed === 0 && report.unchecked.length === 0 && !kids.some((k) => older.has(k));
  return report;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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

/** The report as the CLI prints it: counts and locations, never a value. */
export function formatRotateKeysReport(r: RotateKeysReport): string {
  const lines = [
    `rotate-keys${r.dryRun ? ' (dry run, nothing written)' : ''}: ` +
      `${r.rewritten} value(s) ${r.dryRun ? 'to rewrite' : 'rewritten'} under key ${r.currentKeyId}`,
  ];
  const byKid = (o: Record<string, number>) =>
    Object.keys(o)
      .sort((a, b) => (a === r.currentKeyId ? -1 : b === r.currentKeyId ? 1 : a.localeCompare(b)))
      .map((kid) => `${kid}${kid === r.currentKeyId ? ' (current)' : ''}: ${o[kid]}`);
  for (const line of byKid(r.left)) lines.push(`  under ${line}`);
  if (r.unbound > 0) lines.push(`  of which enc:v1 (unbound): ${r.unbound}`);
  if (r.changed > 0) {
    lines.push(`  changed by a live write during the run: ${r.changed} (run again)`);
  }
  lines.push(`  unopenable under every listed key: ${r.unopenable.length}`);
  for (const u of r.unopenable) {
    lines.push(
      `    ${u.store} field=${u.field} tenant=${u.tenant || '-'} record=${u.record} key=${u.keyId}`,
    );
  }
  const places = Object.keys(r.unvisited).sort();
  if (places.length > 0) lines.push('  not rewritten (counted per key id; none = no listed key):');
  for (const where of places) lines.push(`    ${where}: ${byKid(r.unvisited[where]!).join(', ')}`);
  if (r.unchecked.length > 0) {
    lines.push(
      `  not checked for rows of missing tenants (row-level security binds this role; ` +
        `run with --check-missing-tenants): ${r.unchecked.join(', ')}`,
    );
  }
  lines.push(
    r.oldKeysDroppable
      ? '  No value is left under an older key: older keys can leave the list.'
      : '  Keep every listed key until a run reports nothing under an older one.',
  );
  return lines.join('\n');
}
