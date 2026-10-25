/**
 * A collection starts under the row rules that already name it.
 *
 * The `zv_row_rules` policy was built only by a writer of the rules and by the
 * boot reconcile. A collection created after a `*` rule — or after a rule
 * written for it while its create was still queued — got its table, its tenant
 * policy and no row-rule policy. The policy is RESTRICTIVE, so its absence
 * restricts nothing: the database handed a member every row of the tenant until
 * the next boot. Adopting a table an extension created had the same gap.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { announcingDDLManager } from '../../lib/extensions/register.js';
import { type RlsIdentity, withTenantIsolation } from '../../lib/tenancy/index.js';
import { createRlsPolicy, deleteRlsPolicy } from '../../lib/tenancy/rls.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ts = Date.now();
const STAR = `ccrr_star_${ts}`;
const QUEUED = `ccrr_queued_${ts}`;
const ADOPTED = `ccrr_adopted_${ts}`;
// Unique names: a `*` rule reaches every collection, and nobody else holds ROLE.
const OWNER = `owner_${ts}`;
const ROLE = `ccrr_role_${ts}`;
const ALICE = 'ccrr-alice';
const BOB = 'ccrr-bob';

const field = { name: OWNER, type: 'text', required: false, unique: false, indexed: false };
const member: RlsIdentity = {
  userId: ALICE,
  email: `${ALICE}@test.local`,
  role: 'member',
  roles: [ROLE],
  bypass: false,
  // Every collection may be read: what is left to narrow the rows is the row rule.
  collectionAll: true,
};

d('a new collection carries the row rules already written', () => {
  let db: Database;
  let tenant = '';
  const ruleIds: string[] = [];

  const seed = (name: string) =>
    sql
      .raw(
        `INSERT INTO zvd_${name} (tenant_id, "${OWNER}") VALUES ` +
          `('${tenant}', '${ALICE}'), ('${tenant}', '${BOB}')`,
      )
      .execute(db);

  /** Owners the DATABASE returns to Alice for a query with no rule filter on it. */
  const seen = (name: string) =>
    withTenantIsolation(
      tenant,
      async (trx) =>
        (
          await sql
            .raw<{ o: string }>(`SELECT "${OWNER}" AS o FROM zvd_${name} ORDER BY 1`)
            .execute(trx)
        ).rows.map((r) => r.o),
      { userId: ALICE, identity: member },
    );

  beforeAll(async () => {
    ({ db } = await getTestApp());
    tenant = (
      await sql<{ id: string }>`SELECT id FROM zv_tenants ORDER BY created_at LIMIT 1`.execute(db)
    ).rows[0]!.id;
    const rule = {
      role: ROLE,
      filter_field: OWNER,
      filter_op: 'eq',
      filter_value_source: 'user_id',
    };
    ruleIds.push((await createRlsPolicy({ collection: '*', ...rule })).id);
    // Written while the collection's create is queued: no table to put it on yet.
    ruleIds.push((await createRlsPolicy({ collection: QUEUED, ...rule })).id);
  });

  afterAll(async () => {
    if (!db) return;
    // Through the writer: the `*` rule's term comes off every other table too.
    for (const id of ruleIds) await deleteRlsPolicy(id);
    for (const c of [STAR, QUEUED, ADOPTED]) {
      await sql.raw(`DROP TABLE IF EXISTS "zvd_${c}" CASCADE`).execute(db);
      await db.deleteFrom('zvd_collections').where('name', '=', c).execute();
    }
    await sql`DELETE FROM zvd_permissions WHERE v2 = ANY(${[STAR, QUEUED, ADOPTED]})`.execute(db);
  });

  it('createCollection after a `*` rule: the member sees only her rows', async () => {
    await DDLManager.createCollection(db, { name: STAR, fields: [field] } as never);
    await seed(STAR);
    expect(await seen(STAR)).toEqual([ALICE]);
  });

  it('createCollection after a rule written for it: the member sees only her rows', async () => {
    await DDLManager.createCollection(db, {
      name: QUEUED,
      fields: [field],
      adoptRules: true,
    } as never);
    await seed(QUEUED);
    expect(await seen(QUEUED)).toEqual([ALICE]);
  });

  it('an extension adopting a table it created: the member sees only her rows', async () => {
    await DDLManager.createCollection(db, { name: ADOPTED, fields: [field] } as never);
    // As an extension migration leaves it: the table, with no row-rule policy.
    await sql.raw(`DROP POLICY IF EXISTS zv_row_rules ON zvd_${ADOPTED}`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', ADOPTED).execute();
    await seed(ADOPTED);
    await announcingDDLManager.registerMetadata(db, { name: ADOPTED, fields: [] } as never);
    expect(await seen(ADOPTED)).toEqual([ALICE]);
  });
});
