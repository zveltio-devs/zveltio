/**
 * An extension's writes go through the same field pipeline as everyone else's.
 *
 * `ctx.db.insertInto('zvd_x').values({...})` reached Postgres untouched, so a
 * field type's `deserialize` never ran and `encrypted: true` was ignored. The
 * same value written through POST /api/data was hashed and encrypted; written
 * by an extension it was stored verbatim. Nothing above the storage layer
 * showed a difference — the field renders identically either way, and only the
 * bytes on disk differ.
 *
 * That is the gap import and sync had before they were routed through
 * `processInput`. Fixed in the PROXY rather than by giving extensions a helper
 * to call, because every extension may write `zvd_*` and a helper is
 * forty-four chances to forget.
 *
 * Asserted against the real column contents, because the whole bug is that
 * everything above storage looked correct.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hextwrite_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const PLAINTEXT_PW = 'correct horse battery staple';
const SECRET = 'sk_live_do_not_store_me_in_plaintext';

d('extension writes run through the field pipeline', () => {
  let db: Database;
  // The proxy is addressed with runtime table names, which Kysely's typed API
  // cannot express. Narrow shape rather than `any`.
  type Chain = {
    values(v: Record<string, unknown>): Chain;
    set(v: Record<string, unknown>): Chain;
    where(l: string, op: string, r: unknown): Chain;
    execute(): Promise<unknown>;
  };
  type ExtDb = { insertInto(t: string): Chain; updateTable(t: string): Chain };
  let extDb: ExtDb;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: false, unique: false, indexed: false },
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
    extDb = createRestrictedDb(db, 'probe-ext') as unknown as ExtDb;
  });

  afterAll(async () => {
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
  });

  it('hashes and encrypts on insert', async () => {
    const id = crypto.randomUUID();
    await extDb
      .insertInto(TABLE)
      .values({ id, label: 'via-extension', secret: PLAINTEXT_PW, api_key: SECRET })
      .execute();

    const rows = (await sql
      .raw(`SELECT secret, api_key, label FROM "${TABLE}" WHERE id = '${id}'`)
      .execute(db)) as { rows: { secret: string; api_key: string; label: string }[] };
    const row = rows.rows[0]!;

    // Both used to be the literal values.
    expect(row.secret).not.toBe(PLAINTEXT_PW);
    expect(await Bun.password.verify(PLAINTEXT_PW, row.secret)).toBe(true);
    expect(row.api_key).not.toBe(SECRET);
    expect(row.api_key.startsWith('enc:v1:')).toBe(true);
    // An ordinary column is untouched — encrypting everything would break
    // every query and index.
    expect(row.label).toBe('via-extension');
  });

  it('hashes and encrypts on a single-row update', async () => {
    const id = crypto.randomUUID();
    await extDb.insertInto(TABLE).values({ id, label: 'before' }).execute();
    await extDb
      .updateTable(TABLE)
      .set({ secret: PLAINTEXT_PW, api_key: SECRET })
      .where('id', '=', id)
      .execute();

    const rows = (await sql
      .raw(`SELECT secret, api_key FROM "${TABLE}" WHERE id = '${id}'`)
      .execute(db)) as { rows: { secret: string; api_key: string }[] };
    expect(await Bun.password.verify(PLAINTEXT_PW, rows.rows[0]!.secret)).toBe(true);
    expect(rows.rows[0]!.api_key.startsWith('enc:v1:')).toBe(true);
  });

  it('hashes and encrypts on a bulk update too', async () => {
    // The hook is skipped on a bulk WHERE because it needs a row to describe.
    // The field pipeline only needs the patch, so storing plaintext because
    // the WHERE happened to be broad would be an odd rule.
    const id = crypto.randomUUID();
    await extDb.insertInto(TABLE).values({ id, label: 'bulk-target' }).execute();
    await extDb
      .updateTable(TABLE)
      .set({ api_key: SECRET })
      .where('label', '=', 'bulk-target')
      .execute();

    const rows = (await sql
      .raw(`SELECT api_key FROM "${TABLE}" WHERE id = '${id}'`)
      .execute(db)) as { rows: { api_key: string }[] };
    expect(rows.rows[0]!.api_key.startsWith('enc:v1:')).toBe(true);
  });

  it('refuses a write the collection says is invalid', async () => {
    // A password under the minimum length. It used to be stored as typed.
    await expect(
      extDb
        .insertInto(TABLE)
        .values({ id: crypto.randomUUID(), label: 'short-pw', secret: 'abc' })
        .execute(),
    ).rejects.toThrow(/invalid data/i);

    const rows = (await sql
      .raw(`SELECT id FROM "${TABLE}" WHERE label = 'short-pw'`)
      .execute(db)) as { rows: unknown[] };
    expect(rows.rows.length).toBe(0);
  });

  it('leaves the extension’s own namespace alone', async () => {
    // `zv_<ext>_*` has no collection definition — nothing to validate or
    // encrypt, and the proxy must not invent field rules for it.
    await sql
      .raw(`CREATE TABLE IF NOT EXISTS zv_probe_ext_notes (id uuid primary key, body text)`)
      .execute(db);
    const id = crypto.randomUUID();
    await (createRestrictedDb(db, 'probe-ext') as unknown as ExtDb)
      .insertInto('zv_probe_ext_notes')
      .values({ id, body: 'plain' })
      .execute();
    const rows = (await sql
      .raw(`SELECT body FROM zv_probe_ext_notes WHERE id = '${id}'`)
      .execute(db)) as { rows: { body: string }[] };
    expect(rows.rows[0]!.body).toBe('plain');
    await sql
      .raw('DROP TABLE IF EXISTS zv_probe_ext_notes')
      .execute(db)
      .catch(() => {});
  });
});
