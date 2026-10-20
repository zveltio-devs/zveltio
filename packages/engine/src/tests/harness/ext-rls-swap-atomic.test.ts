/**
 * `reconcileExtensionTenantRLS` swaps a table's `tenant_isolation_*` policy in
 * one transaction.
 *
 * It ran DROP POLICY and CREATE POLICY as separate statements on the pool. A
 * failure between them left the table under FORCE RLS with no permissive
 * policy, so every read through `zveltio_rls` answered nothing until the next
 * boot retried. The plant here is an event trigger that refuses the CREATE.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { reconcileExtensionTenantRLS } from '../../lib/tenancy/tenant-manager.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TABLE = `zv_extswap_${Date.now()}`;
const POLICY = `tenant_isolation_${TABLE}`;
const TRIGGER = `${TABLE}_refuse`;

d('extension policy swap is atomic', () => {
  let db: Database;
  // An event trigger needs a superuser; the non-superuser-owner CI job has none.
  let superuser = false;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    superuser = (
      await sql<{
        s: boolean;
      }>`SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user`.execute(db)
    ).rows[0]!.s;
    if (!superuser) return;
    await sql
      .raw(`CREATE TABLE ${TABLE} (id serial primary key, tenant_id uuid NOT NULL, label text)`)
      .execute(db);
    await sql.raw(`CREATE POLICY ${POLICY} ON ${TABLE} USING (true)`).execute(db);
    await sql
      .raw(
        `CREATE FUNCTION ${TRIGGER}() RETURNS event_trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands()
                       WHERE object_identity LIKE '${POLICY} on %') THEN
             RAISE EXCEPTION 'planted: CREATE POLICY refused';
           END IF;
         END $$`,
      )
      .execute(db);
    await sql
      .raw(
        `CREATE EVENT TRIGGER ${TRIGGER} ON ddl_command_end
           WHEN TAG IN ('CREATE POLICY') EXECUTE FUNCTION ${TRIGGER}()`,
      )
      .execute(db);
  });

  afterAll(async () => {
    if (!superuser) return;
    await sql.raw(`DROP EVENT TRIGGER IF EXISTS ${TRIGGER}`).execute(db);
    await sql.raw(`DROP FUNCTION IF EXISTS ${TRIGGER}()`).execute(db);
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
  });

  it('keeps the old policy when the new one cannot be created', async () => {
    if (!superuser) return;
    expect(await reconcileExtensionTenantRLS(db, [TABLE])).toBe(0);
    const left = await sql<{ policyname: string }>`
      SELECT policyname FROM pg_policies WHERE tablename = ${TABLE}
    `.execute(db);
    expect(left.rows.map((r) => r.policyname)).toEqual([POLICY]);
  });
});
