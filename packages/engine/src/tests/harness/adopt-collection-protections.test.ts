/**
 * A table an extension creates and then adopts (`registerMetadata`) is under
 * what `createCollection` puts on a collection's table, from the adoption on.
 *
 * The extension wrapper registered the row and applied the row-rule policy
 * only. Tenant isolation, the collection-permission policies, the column write
 * guard, the sealed columns and the narrow roles' grants came from the boot
 * reconcile — so between a runtime install and the next boot the request role
 * read another tenant's rows of a table with no policy of its own, read a
 * collection it holds no grant on, read a `password` column, and wrote a column
 * its rules forbid.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { announcingDDLManager } from '../../lib/extensions/register.js';
import { type RlsIdentity, withTenantIsolation } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ts = Date.now();
const NAME = `acp_${ts}`;
const TABLE = `zvd_${NAME}`;
const ROLE = `acp_role_${ts}`;
const ALICE = 'acp-alice';

const identity = (over: Partial<RlsIdentity>): RlsIdentity => ({
  userId: ALICE,
  email: `${ALICE}@test.local`,
  role: 'member',
  roles: [ROLE],
  bypass: false,
  collectionAll: true,
  ...over,
});

d('an adopted collection is protected like a created one', () => {
  let db: Database;
  let mine = '';
  let other = '';

  const asMember = <T>(over: Partial<RlsIdentity>, fn: (trx: Database) => Promise<T>): Promise<T> =>
    withTenantIsolation(mine, fn, { userId: ALICE, identity: identity(over) });

  beforeAll(async () => {
    ({ db } = await getTestApp());
    mine = (
      await sql<{ id: string }>`SELECT id FROM zv_tenants ORDER BY created_at LIMIT 1`.execute(db)
    ).rows[0]!.id;
    other = (
      await sql<{ id: string }>`
        INSERT INTO zv_tenants (name, slug) VALUES (${`acp other ${ts}`}, ${`acp-other-${ts}`})
        RETURNING id`.execute(db)
    ).rows[0]!.id;
    // As an extension migration leaves it: its own table, no isolation of its own.
    await sql
      .raw(
        `CREATE TABLE ${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ` +
          'tenant_id uuid, secret text, note text, ' +
          'created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())',
      )
      .execute(db);
    await sql
      .raw(
        `INSERT INTO ${TABLE} (tenant_id, secret, note) VALUES ` +
          `('${mine}', 'h1', 'mine'), ('${other}', 'h2', 'theirs')`,
      )
      .execute(db);
    // A column rule written before the collection exists.
    await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: NAME,
        column_name: 'note',
        role: ROLE,
        can_read: true,
        can_write: false,
      })
      .execute();
    await announcingDDLManager.registerMetadata(db, {
      name: NAME,
      fields: [
        { name: 'secret', type: 'password' },
        { name: 'note', type: 'text' },
      ],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', NAME).execute();
    await db.deleteFrom('zvd_column_permissions').where('collection_name', '=', NAME).execute();
    await sql`DELETE FROM zvd_permissions WHERE v2 = ${NAME}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${other}`.execute(db);
  });

  it('another tenant’s rows are not read', async () => {
    const notes = await asMember({}, async (trx) =>
      (await sql.raw<{ note: string }>(`SELECT note FROM ${TABLE}`).execute(trx)).rows.map(
        (r) => r.note,
      ),
    );
    expect(notes).toEqual(['mine']);
  });

  it('a caller with no grant on the collection reads nothing', async () => {
    const n = await asMember(
      { collectionAll: false, collectionGrants: '' },
      async (trx) => (await sql.raw(`SELECT id FROM ${TABLE}`).execute(trx)).rows.length,
    );
    expect(n).toBe(0);
  });

  it('the password column is sealed from the request role', async () => {
    const read = asMember({}, (trx) => sql.raw(`SELECT secret FROM ${TABLE}`).execute(trx));
    await expect(read).rejects.toThrow(/permission denied/);
  });

  it('a column the rules forbid is not written', async () => {
    // The guard matches a rule on the caller's direct role.
    const write = asMember({ role: ROLE }, (trx) =>
      sql.raw(`UPDATE ${TABLE} SET note = 'changed'`).execute(trx),
    );
    await expect(write).rejects.toThrow();
  });

  it('the narrow roles reach it as they reach a created collection', async () => {
    const r = await sql<{ ok: boolean }>`
      SELECT has_column_privilege('zveltio_flow_reader', ${TABLE}, 'note', 'SELECT') AS ok`.execute(
      db,
    );
    expect(r.rows[0]?.ok).toBe(true);
  });
});
