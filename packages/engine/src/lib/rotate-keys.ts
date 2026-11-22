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
 * And what an extension sealed itself (step 3): `ctx.internals.encryptSecret`
 * and `maybeEncrypt` seal with no row, so their readers open only unbound
 * envelopes. A whole `enc:v1:` or `aes256gcm:` value in any other text column
 * of a collection is resealed in its own format under the current key of its
 * keyring (`FIELD_ENCRYPTION_KEYS` / `MAIL_ENCRYPTION_KEYS`), never bound;
 * mail keys are reported as `mail:<id>`.
 *
 * Ciphertext it does not rewrite is still COUNTED, per key id ("unvisited"):
 * rows of a tenant missing from `zv_tenants`, revision copies of a field that
 * is no longer sealed or of a row they do not name, ciphertext inside a field
 * value (json, arrays), webhook delivery payloads and pg-boss job payloads. The verdict "older keys can leave the list" holds
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
  isUnboundValue,
  encryptWithKeyring,
  keyList,
  mailKeyId,
  openFieldValue,
  openUnboundValue,
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
  /** The mail key extension-sealed mail values are resealed under; null when none is usable. */
  currentMailKeyId: string | null;
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
  /**
   * Whether no value, visited or not, is left under an older listed key. Holds
   * only if every engine already wrote with this current key when the run
   * started: a replica still on an older list writes under the old key behind
   * the cursor, so run again once the last one has moved.
   */
  oldKeysDroppable: boolean;
}

const FIRST_ID = '00000000-0000-0000-0000-000000000000';
/** Envelopes inside text; base64url, hex and the key id need no escaping. */
const ENVELOPES =
  /enc:v1:[A-Za-z0-9_-]+|enc:v2:[0-9a-f]{8}:[A-Za-z0-9_-]+|enc1:[A-Za-z0-9+/]+=*|aes256gcm:[0-9a-fA-F]+:[0-9a-fA-F]+/g;
/** A column that may hold one, for a server-side filter. */
const HOLDS_ENVELOPE = sql.raw(`'enc:v[12]:|enc1:|aes256gcm:'`);
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
  const mail = keyList('mail');
  const dryRun = opts.dryRun === true;
  const batch = Math.max(1, opts.batchSize ?? 500);
  const report: RotateKeysReport = {
    dryRun,
    currentKeyId: fieldKeyId(list.keys[0]!),
    currentMailKeyId: mail.currentOk ? mailKeyId(mail.keys[0]!) : null,
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

  type Out = { value: string; kid: string };
  type At = { store: string; tenant: string; record: string; field: string };
  /**
   * An unbound envelope (`enc:v1:`, legacy `enc1:`, mail `aes256gcm:`) as it
   * should be stored, and the key it goes under; null when it stays (counted)
   * or no listed key opens it (reported). Mail stays `aes256gcm:` under the
   * current mail key. Field ciphertext comes back `enc:v1:` under the current
   * field key, or bound when `bindTo` names the sealed field it sits in.
   * `enc1:` is always rewritten, so it drains.
   */
  const reseal = async (v: string, at: At, bindTo?: FieldAad): Promise<Out | null> => {
    const opened = await openUnboundValue(v);
    if (!opened) {
      report.unopenable.push({ ...at, keyId: 'none' });
      return null;
    }
    const mailValue = opened.keyring === 'mail';
    const kid = mailValue ? report.currentMailKeyId : report.currentKeyId;
    const stays = opened.current && !v.startsWith('enc1:');
    if (stays || kid === null || dryRun) {
      count(opened.keyId, false);
      if (!stays && kid !== null) report.rewritten++;
      return null;
    }
    const value =
      !mailValue && bindTo
        ? await sealField(opened.plaintext, bindTo)
        : await encryptWithKeyring(opened.plaintext, opened.keyring);
    return { value, kid };
  };
  /** Book rewrites: each that landed under the key it went to, the others as changed. */
  const book = (writes: Array<{ id: string; kid: string }>, hit: Set<string>) => {
    for (const w of writes) {
      if (!hit.has(w.id)) {
        report.changed++;
        continue;
      }
      report.rewritten++;
      report.left[w.kid] = (report.left[w.kid] ?? 0) + 1;
    }
  };

  /**
   * The value `v` should be stored as, or null when it stays: already current
   * and bound, not ciphertext, or not openable (reported). A legacy or mail
   * envelope in a sealed field is resealed as `reseal` says.
   */
  const next = async (v: unknown, aad: FieldAad, store: string): Promise<Out | null> => {
    if (isUnboundValue(v) && !isFieldEnvelope(v)) {
      return reseal(v, { store, tenant: aad.tenant, record: aad.record, field: aad.field }, aad);
    }
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
    return { value: await sealField(opened.plaintext, aad), kid: report.currentKeyId };
  };
  /** Book the outcome of `planned` rewrites under `kid` of which `landed` were written. */
  const landed = (planned: number, written: number, kid = report.currentKeyId) => {
    report.rewritten += written;
    report.changed += planned - written;
    report.left[kid] = (report.left[kid] ?? 0) + written;
  };
  /** Count every envelope in `text` under `where`: a v2 by the key id it names, the others by the key that opens them. */
  const tally = async (where: string, text: string | null | undefined) => {
    for (const env of text?.match(ENVELOPES) ?? []) {
      const kid = env.startsWith('enc:v2:')
        ? env.split(':')[2]!
        : ((await openUnboundValue(env))?.keyId ?? 'none');
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
    // A dry run takes no lock: it names the table instead of lifting FORCE.
    if (forced && !exempt && (!opts.checkMissingTenants || dryRun)) {
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
        SELECT ${text} AS v FROM ${t} WHERE ${MISSING_TENANT} AND ${text} ~ ${HOLDS_ENVELOPE}`.execute(
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
  /** The declared fields that are not sealed: where an extension may have stored its own. */
  const plainByCollection = new Map<string, Set<string>>();
  for (const name of names) {
    const fields = normalizeFields(await DDLManager.getCollection(db, name));
    const isSealed = (f: (typeof fields)[number]) => f.encrypted || f.type === 'secret';
    const sealed = fields.filter(isSealed).map((f) => f.name);
    if (sealed.length > 0) sealedByCollection.set(name, new Set(sealed));
    plainByCollection.set(name, new Set(fields.filter((f) => !isSealed(f)).map((f) => f.name)));
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
            const writes: Array<{ id: string; old: string; new: string; kid: string }> = [];
            for (const { id, v } of rows) {
              const out = await next(v, { tenant, collection, field, record: id }, store);
              if (out !== null) writes.push({ id, old: v, new: out.value, kid: out.kid });
            }
            if (writes.length > 0) {
              const done = await sql<{ id: string }>`
                UPDATE ${t} SET ${col} = w.new
                  FROM jsonb_to_recordset(${JSON.stringify(writes)}::text::jsonb)
                       AS w(id uuid, old text, new text)
                 WHERE ${t}.id = w.id AND ${t}.tenant_id = ${tenant}::uuid AND ${t}.${col} = w.old
                RETURNING ${t}.id::text AS id`.execute(trx);
              book(writes, new Set(done.rows.map((r) => r.id)));
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

  // ── What an extension sealed itself (ADR 0059 step 3) ───────────────────────
  // `encryptSecret` / `maybeEncrypt` name no row and their readers open only
  // unbound envelopes, so a whole one in a text column that is not sealed is
  // resealed in its own format under the current key of its keyring, never
  // bound. Ciphertext inside a value (json, an array) or a v2 copied there is
  // counted, never rewritten. Declared fields only: `search_text` is the search
  // trigger's copy of the text fields and follows each rewrite by itself.
  // ponytail: one scan per tenant per column (a regex seq scan); read the
  // candidate columns of a table in one statement if installs ever hold many.
  for (const collection of names) {
    const table = DDLManager.getTableName(collection);
    const plain = plainByCollection.get(collection);
    const cols = (
      await sql<{ c: string; text: boolean }>`
        SELECT column_name AS c, data_type IN ('text', 'character varying', 'character') AS text
          FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = ${table}
           AND data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY')`.execute(
        db,
      )
    ).rows.filter((r) => plain?.has(r.c));
    if (cols.length === 0) continue;
    const t = sql.id(table);
    for (const { c: field, text } of cols) {
      const col = sql.id(field);
      const store = `${table}.${field}`;
      for (const tenant of tenants) {
        let after = FIRST_ID;
        for (;;) {
          const more = await asTenant(db, tenant, async (trx) => {
            const rows = (
              await sql<{ id: string; v: string }>`
                SELECT id::text AS id, ${col}::text AS v FROM ${t}
                 WHERE tenant_id = ${tenant}::uuid AND id > ${after}::uuid
                   AND ${col}::text ~ ${HOLDS_ENVELOPE}
                 ORDER BY id LIMIT ${batch}`.execute(trx)
            ).rows;
            const writes: Array<{ id: string; old: string; new: string; kid: string }> = [];
            for (const { id, v } of rows) {
              if (!text || !isUnboundValue(v)) {
                const why = text && isBoundFieldValue(v) ? 'bound elsewhere' : 'inside a value';
                await tally(`${store} (${why})`, v);
                continue;
              }
              const out = await reseal(v, { store, tenant, record: id, field });
              if (out !== null) writes.push({ id, old: v, new: out.value, kid: out.kid });
            }
            if (writes.length > 0) {
              const done = await sql<{ id: string }>`
                UPDATE ${t} SET ${col} = w.new
                  FROM jsonb_to_recordset(${JSON.stringify(writes)}::text::jsonb)
                       AS w(id uuid, old text, new text)
                 WHERE ${t}.id = w.id AND ${t}.tenant_id = ${tenant}::uuid AND ${t}.${col} = w.old
                RETURNING ${t}.id::text AS id`.execute(trx);
              book(writes, new Set(done.rows.map((r) => r.id)));
            }
            if (rows.length > 0) after = rows[rows.length - 1]!.id;
            return rows.length === batch;
          });
          if (!more) break;
        }
      }
    }
    const all = cols.map((r) => `${quoteIdent(r.c)}::text`).join(', ');
    await countMissing(table, sql.raw(`concat_ws(' ', ${all})`));
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
               AND (data::text ~ ${HOLDS_ENVELOPE} OR delta::text ~ ${HOLDS_ENVELOPE})
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
              if (!isFieldEnvelope(v)) {
                // A mail envelope, or ciphertext inside a value: not field ciphertext of the row.
                const raw = typeof v === 'string' ? v : JSON.stringify(v);
                await tally(`zv_revisions.${row.collection} (field not sealed)`, raw);
                continue;
              }
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
                copy[field] = out.value;
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
      for (const { id, v } of rows) {
        const out = await next(v, webhookSecretAad(tenant, id), 'zvd_webhooks.secret');
        if (out === null) continue;
        const done = await sql`
          UPDATE zvd_webhooks SET secret = ${out.value}
           WHERE id = ${id}::uuid AND tenant_id = ${tenant}::uuid AND secret = ${v}
          RETURNING id`.execute(trx);
        landed(1, done.rows.length, out.kid);
      }
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
         WHERE tenant_id = ${tenant}::uuid AND payload::text ~ ${HOLDS_ENVELOPE}`.execute(trx);
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
      SELECT data::text AS v FROM ${sql.raw(table)} WHERE data::text ~ ${HOLDS_ENVELOPE}`.execute(
      db,
    );
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
    const updated = { ...conf, s3: { ...s3, secretKey: out.value } };
    const json = JSON.stringify(updated);
    const done = await sql`
      UPDATE zv_settings
         SET value = ${row.wrapped ? sql`to_jsonb(${json}::text)` : sql`${json}::text::jsonb`}
       WHERE key = ${STORAGE_SETTINGS_KEY} AND value::text = ${row.raw}
      RETURNING key`.execute(trx);
    landed(1, done.rows.length, out.kid);
  });

  // The verdict: no value under an older LISTED key, visited, unopenable (a v2
  // bound elsewhere names its key) or not visited, and every table read whole. A v2 naming an unlisted key id, or `none`, is under no key
  // the list still holds, so it does not keep one there.
  const older = new Set([
    ...list.keys.slice(1).map(fieldKeyId),
    // Without a usable current mail key, every listed one is older.
    ...(mail.currentOk ? mail.keys.slice(1) : mail.keys).map(mailKeyId),
  ]);
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
      `${r.rewritten} value(s) ${r.dryRun ? 'to rewrite' : 'rewritten'} under key ${r.currentKeyId}` +
      (r.currentMailKeyId ? ` (mail values: ${r.currentMailKeyId})` : ''),
  ];
  const current = (kid: string) => kid === r.currentKeyId || kid === r.currentMailKeyId;
  const byKid = (o: Record<string, number>) =>
    Object.keys(o)
      .sort((a, b) => (current(a) ? -1 : current(b) ? 1 : a.localeCompare(b)))
      .map((kid) => `${kid}${current(kid) ? ' (current)' : ''}: ${o[kid]}`);
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
      ? '  No value is left under an older key: older keys can leave the list, provided every\n' +
          '  engine already wrote with this current key when the run started (otherwise run again).'
      : '  Keep every listed key until a run reports nothing under an older one.',
  );
  return lines.join('\n');
}
