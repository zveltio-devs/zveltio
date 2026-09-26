/**
 * Migration 017 removes the Casbin rows of users deleted before #670 — and
 * nothing that is a role.
 *
 * Until #670, `DELETE /api/users/:id` removed the user row and left every
 * `zvd_permissions` row whose subject was that id. A role name and a
 * better-auth id look the same in `v0`, so the migration's evidence is the
 * audit trail (`user.deleted`, `resource_id` = the id) — and the audit trail
 * is not proof on its own: the old route audited whatever id it was given,
 * user or not. So each rule that keeps a real role is planted here:
 *
 *   - a role edge whose child looks like an id but was never deleted;
 *   - a role someone passed to DELETE /api/users/:id, which still has members;
 *   - a registered (`zv_roles`) role with the same history and no members;
 *   - a built-in role (`tenant_viewer`) with the same history;
 *   - a live user who carries a `user.deleted` event anyway.
 *
 * Then the running engine: its enforcer loaded the orphan's rows, and the
 * reconcile tick — not a `loadPolicy` on the live enforcer — must drop them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { getEnforcer, reconcilePolicies } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
// better-auth ids are 32 alphanumerics; so, deliberately, is the role edge.
const tag = `${Date.now()}`.padEnd(16, '0');
const ORPHAN = `Orph${tag}an000000000000`;
const ID_LIKE_ROLE = `Role${tag}xx000000000000`;
const LIVE = `Live${tag}us000000000000`;
const MISTAKEN = `probe_role_${tag}`; // a role once passed to DELETE /api/users/:id
const REGISTERED = `probe_registered_${tag}`;
const RESOURCE = `probe_res_${tag}`;
const SUBJECTS = [ORPHAN, ID_LIKE_ROLE, LIVE, MISTAKEN, REGISTERED];

async function rows(db: Database, v0: string): Promise<string[]> {
  const r = await sql<{ t: string }>`
    SELECT concat_ws(',', ptype, v1, v2, v3) AS t FROM zvd_permissions
     WHERE v0 = ${v0} AND (v2 = ${RESOURCE} OR ptype = 'g') ORDER BY 1
  `.execute(db);
  return r.rows.map((x) => x.t);
}

const deleted = (db: Database, id: string) =>
  sql`INSERT INTO zv_audit_log (event_type, resource_id, resource_type)
      VALUES ('user.deleted', ${id}, 'user')`.execute(db);

d('migration 017 prunes only the rows of users deleted before #670', () => {
  let db: Database;
  let up = '';
  let viewerBefore: string[] = [];

  beforeAll(async () => {
    ({ db } = await getTestApp());
    const file = Bun.file(
      new URL('../../db/migrations/sql/017_prune_deleted_user_grants.sql', import.meta.url),
    );
    up = parseMigrationFile(await file.text()).up;

    for (const id of [ORPHAN, LIVE]) {
      await sql`
        INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        VALUES (${id}, 'Probe', ${`${id}@probe.invalid`}, false, now(), now())
      `.execute(db);
    }
    await sql`INSERT INTO zv_roles (name) VALUES (${REGISTERED})`.execute(db);
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3) VALUES
        ('g', ${ORPHAN}, 'employee', '*', NULL),
        ('g', ${ORPHAN}, 'tenant_member', '00000000-0000-0000-0000-000000000001', NULL),
        ('p', ${ORPHAN}, '*', ${RESOURCE}, 'read'),
        ('g', ${ID_LIKE_ROLE}, 'employee', '*', NULL),
        ('p', ${ID_LIKE_ROLE}, '*', ${RESOURCE}, 'read'),
        ('g', ${LIVE}, ${MISTAKEN}, '*', NULL),
        ('p', ${LIVE}, '*', ${RESOURCE}, 'read'),
        ('g', ${MISTAKEN}, 'employee', '*', NULL),
        ('p', ${MISTAKEN}, '*', ${RESOURCE}, 'read'),
        ('p', ${REGISTERED}, '*', ${RESOURCE}, 'read'),
        ('p', 'tenant_viewer', '*', ${RESOURCE}, 'read')
    `.execute(db);

    // What the pre-#670 route did: the user row goes, the audit row is written,
    // the Casbin rows stay. And what it did for any other id it was handed.
    // Replica mode skips triggers: this is a delete from before 017's trigger.
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await sql`DELETE FROM "user" WHERE id = ${ORPHAN}`.execute(trx);
    });
    for (const id of [ORPHAN, LIVE, MISTAKEN, REGISTERED, 'tenant_viewer']) await deleted(db, id);

    viewerBefore = await rows(db, 'tenant_viewer');
    await reconcilePolicies(); // the running engine now holds the orphan's rows
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ANY(${SUBJECTS}) OR v2 = ${RESOURCE}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_audit_log WHERE event_type = 'user.deleted'
               AND resource_id = ANY(${[...SUBJECTS, 'tenant_viewer']})`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM "user" WHERE id = ANY(${SUBJECTS})`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_roles WHERE name = ${REGISTERED}`.execute(db).catch(() => {});
    await reconcilePolicies();
  });

  it('removes every row whose subject is a deleted user', async () => {
    const e = await getEnforcer();
    expect(await e.getRolesForUser(ORPHAN, '*')).toEqual(['employee']);
    await sql.raw(up).execute(db);
    expect(await rows(db, ORPHAN)).toEqual([]);
  });

  it('keeps a role edge whose child looks like an id but was never deleted', async () => {
    expect(await rows(db, ID_LIKE_ROLE)).toEqual(['g,employee,*', `p,*,${RESOURCE},read`]);
  });

  it('keeps a role that was passed to the delete route but still has members', async () => {
    expect(await rows(db, MISTAKEN)).toEqual(['g,employee,*', `p,*,${RESOURCE},read`]);
  });

  it('keeps a registered role and a built-in role with the same history', async () => {
    expect(await rows(db, REGISTERED)).toEqual([`p,*,${RESOURCE},read`]);
    expect(await rows(db, 'tenant_viewer')).toEqual(viewerBefore);
  });

  it('keeps a live user even when an audit row says it was deleted', async () => {
    expect(await rows(db, LIVE)).toEqual([`g,${MISTAKEN},*`, `p,*,${RESOURCE},read`]);
  });

  it('reaches a running engine through the reconcile tick', async () => {
    expect(await reconcilePolicies()).toBe(true);
    const e = await getEnforcer();
    expect(await e.getRolesForUser(ORPHAN, '*')).toEqual([]);
    expect(await e.getRolesForUser(ID_LIKE_ROLE, '*')).toEqual(['employee']);
  });

  it('is idempotent', async () => {
    await sql.raw(up).execute(db);
    expect(await rows(db, ID_LIKE_ROLE)).toHaveLength(2);
    expect(await rows(db, LIVE)).toHaveLength(2);
  });
});

/**
 * The trigger 017 puts on "user": SCIM deprovisioning, GDPR erasure and a psql
 * prompt delete the row with raw SQL and never call the enforcer. Whoever
 * deletes it, the user's `g` and `p` rows go with it — and nobody else's.
 */
d('migration 017 trigger: a deleted user row takes its Casbin rows with it', () => {
  let db: Database;
  const t = `${Date.now()}`.padEnd(16, '1');
  const GONE = `Gone${t}us000000000000`;
  const KEPT = `Kept${t}us000000000000`;
  const ROLE = `probe_trigger_role_${t}`;
  const RES = `probe_trigger_res_${t}`;

  const of = async (v0: string) =>
    (
      await sql<{ t: string }>`
        SELECT concat_ws(',', ptype, v1, v2, v3) AS t FROM zvd_permissions
         WHERE v0 = ${v0} ORDER BY 1`.execute(db)
    ).rows.map((r) => r.t);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    for (const id of [GONE, KEPT]) {
      await sql`
        INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        VALUES (${id}, 'Probe', ${`${id}@probe.invalid`}, false, now(), now())
      `.execute(db);
    }
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3) VALUES
        ('g', ${GONE}, ${ROLE}, '*', NULL),
        ('g', ${GONE}, 'tenant_member', '00000000-0000-0000-0000-000000000001', NULL),
        ('p', ${GONE}, '*', ${RES}, 'read'),
        ('g', ${KEPT}, ${ROLE}, '*', NULL),
        ('p', ${KEPT}, '*', ${RES}, 'read'),
        ('g', ${ROLE}, 'employee', '*', NULL),
        ('p', ${ROLE}, '*', ${RES}, 'read')
    `.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 IN (${GONE}, ${KEPT}, ${ROLE}) OR v2 = ${RES}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM "user" WHERE id IN (${GONE}, ${KEPT})`.execute(db).catch(() => {});
    await reconcilePolicies();
  });

  it('a raw SQL delete of the user row removes its g and p rows', async () => {
    expect(await of(GONE)).toHaveLength(3);
    await sql`DELETE FROM "user" WHERE id = ${GONE}`.execute(db);
    expect(await of(GONE)).toEqual([]);
  });

  it("leaves another user's rows and every role row alone", async () => {
    expect(await of(GONE)).toEqual([]);
    expect(await of(KEPT)).toEqual([`g,${ROLE},*`, `p,*,${RES},read`]);
    expect(await of(ROLE)).toEqual(['g,employee,*', `p,*,${RES},read`]);
    const members = await sql<{ v0: string }>`
      SELECT v0 FROM zvd_permissions WHERE ptype = 'g' AND v1 = ${ROLE}`.execute(db);
    expect(members.rows.map((r) => r.v0)).toEqual([KEPT]);
  });
});
