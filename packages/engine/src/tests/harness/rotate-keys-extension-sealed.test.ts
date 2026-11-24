/**
 * `zveltio rotate-keys` over what an extension sealed itself (ADR 0059 step 3).
 *
 * `ctx.internals.encryptSecret` seals with the field keyring (`enc:v1:`) or the
 * mail keyring (`aes256gcm:`) and names no row, so its reader,
 * `decryptSecret`, opens only those unbound envelopes. Stored in a column that
 * is not `encrypted` or `secret`, such a value was neither rewritten nor
 * counted: the run said the old field key could go while it still held one,
 * and it never looked at `MAIL_ENCRYPTION_KEYS` at all.
 *
 * Planted under K0 / M0 through the real extension surface: a field-keyring and
 * a mail-keyring value in a plain text column, one under a mail key nobody
 * listed, one inside a json column, a revision copy and a row of a missing
 * tenant. Beside them the legacy `enc1:` (field key) in a plain and in an
 * `encrypted` field, and a mail value in the `encrypted` field: the pass over
 * sealed fields skipped anything not `enc:v1:`/`enc:v2:`, uncounted.
 * Then the lists become K1,K0 and M1,M0 and the command runs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createCipheriv } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, decryptField } from '../../lib/data/index.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { rotateKeys } from '../../lib/rotate-keys.js';
import { fieldKeyId, mailKeyId, openUnboundValue } from '../../lib/security/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import {
  asDefaultTenant,
  asTenant,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() && process.env.FIELD_ENCRYPTION_KEY ? describe : describe.skip;
const COLLECTION = `hrkext_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const K0 = process.env.FIELD_ENCRYPTION_KEY ?? '';
// Restored, not deleted: a run that sets them must find them as it left them.
const savedKeys = process.env.FIELD_ENCRYPTION_KEYS;
const savedMailKeys = process.env.MAIL_ENCRYPTION_KEYS;
const K1 = '1'.repeat(64);
const M0 = 'a'.repeat(64);
const M1 = 'b'.repeat(64);
const M9 = '9'.repeat(64);
const id = () => crypto.randomUUID();
const R = {
  field: id(),
  mail: id(),
  lost: id(),
  nested: id(),
  legacy: id(),
  legacySealed: id(),
  mailSealed: id(),
};
/** The envelope migrators 1.x wrote with node:crypto: `enc1:` base64(iv | tag | ct). */
function enc1(plain: string, hex: string): string {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = createCipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}
const REV = id();
const ORPHAN = id();
const ORPHAN_ROW = id();

d('rotate-keys: extension-sealed values (ADR 0059 step 3)', () => {
  let db: Database;
  const internals = buildExtensionInternals();
  const savedMail = process.env.MAIL_ENCRYPTION_KEY;
  const read = async () => {
    const rows = await asDefaultTenant(
      db,
      sql<{ id: string; label: string | null; meta: string | null; sealed: string | null }>`
        SELECT id::text AS id, label, meta::text AS meta, sealed FROM ${sql.table(TABLE)}`,
    );
    return new Map(rows.rows.map((r) => [r.id, r]));
  };
  const mine = (r: Awaited<ReturnType<typeof rotateKeys>>) =>
    r.unopenable.filter((u) => u.store.startsWith(TABLE)).map((u) => u.record);
  let planted: Awaited<ReturnType<typeof read>>;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    process.env.MAIL_ENCRYPTION_KEY = M0;
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: false, unique: false, indexed: false },
        { name: 'meta', type: 'json', required: false, unique: false, indexed: false },
        { name: 'token', type: 'secret', required: false, unique: false, indexed: false },
        {
          name: 'sealed',
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

    const field = await internals.encryptSecret('ext-field');
    const mail = await internals.encryptSecret('ext-mail', { keyring: 'mail' });
    const nested = await internals.encryptSecret('ext-nested');
    process.env.MAIL_ENCRYPTION_KEY = M9;
    const lost = await internals.encryptSecret('lost', { keyring: 'mail' });
    process.env.MAIL_ENCRYPTION_KEY = M0;
    expect(field.startsWith('enc:v1:') && mail.startsWith('aes256gcm:')).toBe(true);

    await asDefaultTenant(db, async (trx) => {
      const t = sql.table(TABLE);
      const ins = (rid: string, label: string | null, meta: unknown = null, sealed?: string) =>
        sql`INSERT INTO ${t} (id, tenant_id, label, meta, sealed)
            VALUES (${rid}::uuid, ${DEFAULT_TENANT_ID}::uuid, ${label},
                    ${meta === null ? null : JSON.stringify(meta)}::text::jsonb,
                    ${sealed ?? null})`.execute(trx);
      await ins(R.field, field);
      await ins(R.mail, mail);
      await ins(R.lost, lost);
      await ins(R.nested, null, { tok: nested });
      await ins(R.legacy, enc1('ext-legacy', K0));
      await ins(R.legacySealed, null, null, enc1('legacy-sealed', K0));
      await ins(R.mailSealed, null, null, mail);
      await sql`INSERT INTO zv_revisions (id, collection, record_id, action, data, tenant_id)
                VALUES (${REV}::uuid, ${COLLECTION}, ${R.mail}, 'update',
                        ${JSON.stringify({ id: R.mail, tenant_id: DEFAULT_TENANT_ID, label: mail })}::text::jsonb,
                        ${DEFAULT_TENANT_ID}::uuid)`.execute(trx);
    });
    await asTenant(db, ORPHAN, (trx) =>
      sql`INSERT INTO ${sql.table(TABLE)} (id, tenant_id, label)
          VALUES (${ORPHAN_ROW}::uuid, ${ORPHAN}::uuid, ${mail})`.execute(trx),
    );
    planted = await read();
    process.env.FIELD_ENCRYPTION_KEYS = `${K1},${K0}`;
    process.env.MAIL_ENCRYPTION_KEYS = `${M1},${M0}`;
  }, 60_000);

  afterAll(async () => {
    if (savedKeys === undefined) delete process.env.FIELD_ENCRYPTION_KEYS;
    else process.env.FIELD_ENCRYPTION_KEYS = savedKeys;
    if (savedMailKeys === undefined) delete process.env.MAIL_ENCRYPTION_KEYS;
    else process.env.MAIL_ENCRYPTION_KEYS = savedMailKeys;
    process.env.FIELD_ENCRYPTION_KEY = K0;
    if (savedMail === undefined) delete process.env.MAIL_ENCRYPTION_KEY;
    else process.env.MAIL_ENCRYPTION_KEY = savedMail;
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
    await asDefaultTenant(db, (trx) =>
      trx.deleteFrom('zv_revisions').where('collection', '=', COLLECTION).execute(),
    ).catch(() => {});
  });

  it('--dry-run counts them under their keys, the mail key too, and writes nothing', async () => {
    const r = await rotateKeys(db, { dryRun: true });
    expect(r.currentMailKeyId).toBe(mailKeyId(M1));
    expect(r.left[fieldKeyId(K0)]).toBeGreaterThanOrEqual(1);
    // Field: the v1 value and both enc1:; mail: the plain and the sealed field.
    expect(r.left[fieldKeyId(K0)]).toBeGreaterThanOrEqual(3);
    expect(r.left[mailKeyId(M0)]).toBeGreaterThanOrEqual(2);
    expect(mine(r)).toEqual([R.lost]);
    expect(r.oldKeysDroppable).toBe(false);
    expect(await read()).toEqual(planted);
  });

  it('reseals each under the current key of its keyring, in its own format', async () => {
    const r = await rotateKeys(db, { batchSize: 1, checkMissingTenants: true });
    const now = await read();
    const field = now.get(R.field)!.label!;
    const mail = now.get(R.mail)!.label!;
    expect(field.startsWith('enc:v1:') && field !== planted.get(R.field)!.label).toBe(true);
    expect((await openUnboundValue(field))?.keyId).toBe(fieldKeyId(K1));
    expect(mail.startsWith('aes256gcm:')).toBe(true);
    expect((await openUnboundValue(mail))?.keyId).toBe(mailKeyId(M1));
    expect(r.changed).toBe(0);

    // enc1: drains: as enc:v1 in a plain field, bound in an encrypted one.
    const legacy = now.get(R.legacy)!.label!;
    expect(legacy.startsWith('enc:v1:')).toBe(true);
    expect(await internals.decryptSecret(legacy)).toBe('ext-legacy');
    const legacySealed = now.get(R.legacySealed)!.sealed!;
    expect(legacySealed.startsWith(`enc:v2:${fieldKeyId(K1)}:`)).toBe(true);
    const at = {
      tenant: DEFAULT_TENANT_ID,
      collection: COLLECTION,
      field: 'sealed',
      record: R.legacySealed,
    };
    expect(await decryptField(legacySealed, at)).toBe('legacy-sealed');
    // A mail value in an encrypted field stays mail, under the current mail key.
    const mailSealed = now.get(R.mailSealed)!.sealed!;
    expect((await openUnboundValue(mailSealed))?.keyId).toBe(mailKeyId(M1));

    // Fail closed: under a mail key nobody listed, reported and left as it was.
    expect(mine(r)).toEqual([R.lost]);
    expect(now.get(R.lost)!.label).toBe(planted.get(R.lost)!.label);

    // Where there is no whole value to reseal, counted under its key: K0 and M0 stay.
    expect(now.get(R.nested)!.meta).toBe(planted.get(R.nested)!.meta);
    expect(r.unvisited[`${TABLE}.meta (inside a value)`]?.[fieldKeyId(K0)]).toBe(1);
    expect(r.unvisited[`zv_revisions.${COLLECTION} (field not sealed)`]?.[mailKeyId(M0)]).toBe(1);
    const exempt = (
      await sql<{ ok: boolean }>`
        SELECT rolsuper OR rolbypassrls AS ok FROM pg_roles WHERE rolname = current_user`.execute(
        db,
      )
    ).rows[0]!.ok;
    if (exempt) expect(r.unvisited[`${TABLE} (tenant missing)`]?.[mailKeyId(M0)]).toBe(1);
    expect(r.oldKeysDroppable).toBe(false);
  });

  it('--dry-run takes no lock: a forced table it cannot read is named, flag or not', async () => {
    const exempt = (
      await sql<{ ok: boolean }>`
        SELECT rolsuper OR rolbypassrls AS ok FROM pg_roles WHERE rolname = current_user`.execute(
        db,
      )
    ).rows[0]!.ok;
    const r = await rotateKeys(db, { dryRun: true, checkMissingTenants: true });
    if (!exempt) expect(r.unchecked).toContain(TABLE);
    else expect(r.unchecked).toEqual([]);
  });

  it('a second run rewrites nothing', async () => {
    const before = await read();
    const r = await rotateKeys(db);
    expect(r.rewritten).toBe(0);
    expect(await read()).toEqual(before);
  });

  it('K0 and M0 then leave the lists: the extension still reads what it sealed', async () => {
    await asDefaultTenant(db, async (trx) => {
      await sql`DELETE FROM zv_revisions WHERE id = ${REV}::uuid`.execute(trx);
      await sql`DELETE FROM ${sql.table(TABLE)} WHERE id IN (${R.nested}::uuid, ${R.lost}::uuid)`.execute(
        trx,
      );
    });
    await asTenant(db, ORPHAN, (trx) =>
      sql`DELETE FROM ${sql.table(TABLE)} WHERE id = ${ORPHAN_ROW}::uuid`.execute(trx),
    );
    const r = await rotateKeys(db, { checkMissingTenants: true });
    expect(Object.keys(r.unvisited).filter((k) => k.includes(COLLECTION))).toEqual([]);
    expect(mine(r)).toEqual([]);

    process.env.FIELD_ENCRYPTION_KEYS = K1;
    process.env.FIELD_ENCRYPTION_KEY = K1;
    process.env.MAIL_ENCRYPTION_KEYS = M1;
    process.env.MAIL_ENCRYPTION_KEY = M1;
    try {
      const now = await read();
      expect(await internals.decryptSecret(now.get(R.field)!.label!)).toBe('ext-field');
      expect(await internals.decryptSecret(now.get(R.mail)!.label!, { keyring: 'mail' })).toBe(
        'ext-mail',
      );
    } finally {
      process.env.FIELD_ENCRYPTION_KEYS = `${K1},${K0}`;
      process.env.FIELD_ENCRYPTION_KEY = K0;
      process.env.MAIL_ENCRYPTION_KEYS = `${M1},${M0}`;
      process.env.MAIL_ENCRYPTION_KEY = M0;
    }
  });
});
