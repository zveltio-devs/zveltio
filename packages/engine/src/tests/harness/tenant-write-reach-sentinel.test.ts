/**
 * Migration 060's write check refuses only the NO_UNITS sentinel; it never asks
 * whether the published read set contains the current tenant (measured: with
 * `zveltio.visible_tenants` set to another tenant, an INSERT into the current
 * one passes). That is sound only while every publisher keeps one invariant: a
 * published set is empty, NO_UNITS, or contains the request's own tenant. This
 * suite pins it on every engine publisher.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  NO_UNITS,
  publishEveryTenant,
  withEveryTenant,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = `wsent_${Date.now()}`;
const ROOT = crypto.randomUUID();
const CHILD = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const USERS = {
  self: `${STAMP}_self`,
  subtree: `${STAMP}_subtree`,
  list: `${STAMP}_list`,
  org: `${STAMP}_org`,
  lapsed: `${STAMP}_lapsed`,
  none: `${STAMP}_none`,
};

d('060 write sentinel: the published read set always holds the own tenant', () => {
  let db: Database;
  let godId: string;

  const published = (tenant: string, userId?: string) =>
    withTenantIsolation(
      tenant,
      async (trx) =>
        (
          await sql<{ v: string }>`
            SELECT current_setting('zveltio.visible_tenants', true) AS v`.execute(trx)
        ).rows[0]!.v,
      userId ? { userId } : undefined,
    );

  /** The invariant 060's sentinel relies on. */
  const holdsOwn = (csv: string, tenant: string) =>
    csv === '' || csv === NO_UNITS || csv.split(',').includes(tenant);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    const { app } = await getTestApp();
    await createGodSession(app, db);
    godId = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]!.id;
    await sql`INSERT INTO zv_tenants (id, slug, name, status) VALUES
      (${ROOT}::uuid, ${`${STAMP}-r`}, 'r', 'active'),
      (${OTHER}::uuid, ${`${STAMP}-o`}, 'o', 'active')`.execute(db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status, parent_id)
      VALUES (${CHILD}::uuid, ${`${STAMP}-c`}, 'c', 'active', ${ROOT}::uuid)`.execute(db);
    for (const id of Object.values(USERS)) {
      await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        VALUES (${id}, ${id}, ${`${id}@test.local`}, true, now(), now())`.execute(db);
    }
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, read_scope, scope_list, valid_to)
      VALUES (${ROOT}::uuid, ${USERS.self}, 'self', NULL, NULL),
             (${ROOT}::uuid, ${USERS.subtree}, 'subtree', NULL, NULL),
             (${ROOT}::uuid, ${USERS.list}, 'list', ARRAY[${OTHER}::uuid], NULL),
             (${ROOT}::uuid, ${USERS.org}, 'org', NULL, NULL),
             (${ROOT}::uuid, ${USERS.lapsed}, 'self', NULL, now() - interval '1 day')`.execute(db);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM "user" WHERE id LIKE ${`${STAMP}%`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${CHILD}::uuid`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id IN (${ROOT}::uuid, ${OTHER}::uuid)`.execute(db);
  });

  it('every reach branch publishes NO_UNITS, nothing, or a set holding the own tenant', async () => {
    const seen: Record<string, string> = {};
    for (const [branch, id] of Object.entries(USERS)) seen[branch] = await published(ROOT, id);
    seen.god = await published(ROOT, godId);
    seen.godChild = await published(CHILD, godId);
    seen.noUser = await published(ROOT);
    // The branches are what they claim to be, so the check below is not vacuous.
    expect(seen.lapsed).toBe(NO_UNITS);
    expect(seen.none).toBe('');
    expect(seen.noUser).toBe('');
    expect(seen.self).toBe(ROOT);
    expect(seen.subtree!.split(',').sort()).toEqual([ROOT, CHILD].sort());
    expect(seen.list!.split(',')).toEqual([ROOT, OTHER]);
    expect(seen.org!.split(',')).toContain(OTHER);
    for (const [branch, csv] of Object.entries(seen)) {
      const own = branch === 'godChild' ? CHILD : ROOT;
      expect({ branch, holds: holdsOwn(csv, own) }).toEqual({ branch, holds: true });
    }
  });

  it('the every-tenant reach holds every tenant a writer can switch to', async () => {
    const ids = (await sql<{ id: string }>`SELECT id::text AS id FROM zv_tenants`.execute(db)).rows;
    const fromEvery = await withEveryTenant(db, async (trx) =>
      (
        await sql<{
          v: string;
        }>`SELECT current_setting('zveltio.visible_tenants', true) AS v`.execute(trx)
      ).rows[0]!.v.split(','),
    );
    const fromPublish = await db.transaction().execute(async (trx) => {
      await publishEveryTenant(trx);
      return (
        await sql<{
          v: string;
        }>`SELECT current_setting('zveltio.visible_tenants', true) AS v`.execute(trx)
      ).rows[0]!.v.split(',');
    });
    for (const { id } of ids) {
      expect(fromEvery).toContain(id);
      expect(fromPublish).toContain(id);
    }
  });
});
