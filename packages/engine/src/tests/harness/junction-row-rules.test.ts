/**
 * A junction table starts under the row rules that already name it.
 *
 * Rules outlive a junction: removing an m2m relation drops `zvd_jnc_<a>_<b>`
 * and leaves the rules written for `jnc_<a>_<b>`, and a rule may be written
 * before the junction exists. The boot reconcile puts them on the table
 * (`rowRuleCollections` lists every collection a rule names), but the create
 * did not — the table came up with no `zv_row_rules` policy, RESTRICTIVE, so
 * a member read every link of the tenant until the next boot.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { type RlsIdentity, withTenantIsolation } from '../../lib/tenancy/index.js';
import { createRlsPolicy, deleteRlsPolicy } from '../../lib/tenancy/rls.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ts = Date.now();
const SRC = `jrr_src_${ts}`;
const DST = `jrr_dst_${ts}`;
const JNC = `jnc_${SRC}_${DST}`;
const ROLE = `jrr_role_${ts}`;
const KEPT = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const LINK = crypto.randomUUID();

const field = { name: 'title', type: 'text', required: false, unique: false, indexed: false };
const member: RlsIdentity = {
  userId: 'jrr-alice',
  email: 'jrr-alice@test.local',
  role: 'member',
  roles: [ROLE],
  bypass: false,
  collectionAll: true,
};

d('a new junction carries the row rules already written for it', () => {
  let db: Database;
  let tenant = '';
  let ruleId = '';

  beforeAll(async () => {
    ({ db } = await getTestApp());
    tenant = (
      await sql<{ id: string }>`SELECT id FROM zv_tenants ORDER BY created_at LIMIT 1`.execute(db)
    ).rows[0]!.id;
    await DDLManager.createCollection(db, { name: SRC, fields: [field] } as never);
    await DDLManager.createCollection(db, { name: DST, fields: [field] } as never);
    // No junction yet: the rule waits for it, as one left by a removed relation does.
    ruleId = (
      await createRlsPolicy({
        collection: JNC,
        role: ROLE,
        filter_field: `${SRC}_id`,
        filter_op: 'eq',
        filter_value_source: `static:${KEPT}`,
      })
    ).id;
  });

  afterAll(async () => {
    if (!db) return;
    if (ruleId) await deleteRlsPolicy(ruleId);
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${JNC}" CASCADE`).execute(db);
    for (const c of [SRC, DST]) {
      await sql.raw(`DROP TABLE IF EXISTS "zvd_${c}" CASCADE`).execute(db);
      await db.deleteFrom('zvd_collections').where('name', '=', c).execute();
    }
    await sql`DELETE FROM zvd_permissions WHERE v2 = ANY(${[SRC, DST]})`.execute(db);
  });

  it('createJunctionTable: the member sees only the links the rule leaves her', async () => {
    await DDLManager.createJunctionTable(db, SRC, DST);
    await sql
      .raw(
        `INSERT INTO "zvd_${SRC}" (id, tenant_id) VALUES ('${KEPT}', '${tenant}'), ('${OTHER}', '${tenant}');` +
          `INSERT INTO "zvd_${DST}" (id, tenant_id) VALUES ('${LINK}', '${tenant}');` +
          `INSERT INTO "zvd_${JNC}" (tenant_id, "${SRC}_id", "${DST}_id") VALUES ` +
          `('${tenant}', '${KEPT}', '${LINK}'), ('${tenant}', '${OTHER}', '${LINK}')`,
      )
      .execute(db);
    const seen = await withTenantIsolation(
      tenant,
      async (trx) =>
        (
          await sql
            .raw<{ s: string }>(`SELECT "${SRC}_id"::text AS s FROM "zvd_${JNC}"`)
            .execute(trx)
        ).rows.map((r) => r.s),
      { userId: member.userId, identity: member },
    );
    expect(seen).toEqual([KEPT]);
  });
});
