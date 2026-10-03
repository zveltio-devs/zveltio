/**
 * `ctx.db.transaction()` inside a request joins the request's transaction — and
 * must still undo its own block when that block throws.
 *
 * The join ran the callback on the request transaction directly. A throw became
 * the handler's error response, the request's transaction committed as usual,
 * and every write made before the throw stayed. Measured on SCIM: a PatchOp that
 * renamed the god and then tried to deactivate them was refused, and the rename
 * and the "inactive" flag were both kept. A SAVEPOINT makes the block atomic.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { grantExtensionDbRole, revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { getCurrentTenantTrx } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
// The probe's own table. It used to be `"user"`, granted for the purpose — which
// the role `ctx.db` runs as (ext-db-role.ts) never holds, grant or no grant.
const ROWS = 'zv_probe_jt_rows';

d("an extension's joined transaction", () => {
  let db: Database;
  const userId = 'row-1';
  // The handle production gives an extension: the current request transaction.
  const extDb = () => createRestrictedDb(() => getCurrentTenantTrx() ?? db, 'probe');
  const nameOf = async () =>
    (
      await sql<{ name: string }>`SELECT name FROM ${sql.table(ROWS)} WHERE id = ${userId}`.execute(
        db,
      )
    ).rows[0]!.name;

  beforeAll(async () => {
    db = (await getTestApp()).db;
    await sql`CREATE TABLE IF NOT EXISTS ${sql.table(ROWS)} (
      id text PRIMARY KEY, name text, "emailVerified" boolean NOT NULL DEFAULT false)`.execute(db);
    // What loading the extension does once its migrations have made the table.
    await grantExtensionDbRole(db, 'probe', new Set());
    await sql`INSERT INTO ${sql.table(ROWS)} (id, name) VALUES (${userId}, 'Before')`.execute(db);
  });

  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS ${sql.table(ROWS)}`.execute(db);
    await revokeExtensionDbRoles(db, 'probe', true);
  });

  it('rolls its own writes back on a throw, and the request still commits the rest', async () => {
    await buildExtensionInternals().withTenantIsolation(TENANT, async (trx) => {
      await expect(
        extDb()
          .transaction()
          .execute(async (t) => {
            await sql`UPDATE ${sql.table(ROWS)} SET name = 'Inside' WHERE id = ${userId}`.execute(
              t,
            );
            throw new Error('refused half-way');
          }),
      ).rejects.toThrow('refused half-way');
      // The request carries on and writes after the failed block.
      await sql`UPDATE ${sql.table(ROWS)} SET "emailVerified" = true WHERE id = ${userId}`.execute(
        trx,
      );
    });

    expect(await nameOf()).toBe('Before');
    const v = await sql<{ ok: boolean }>`
      SELECT "emailVerified" AS ok FROM ${sql.table(ROWS)} WHERE id = ${userId}`.execute(db);
    expect(v.rows[0]!.ok).toBe(true);
  });

  it('commits with the request when the block succeeds', async () => {
    await buildExtensionInternals().withTenantIsolation(TENANT, () =>
      extDb()
        .transaction()
        .execute(async (t) => {
          await sql`UPDATE ${sql.table(ROWS)} SET name = 'Committed' WHERE id = ${userId}`.execute(
            t,
          );
        }),
    );
    expect(await nameOf()).toBe('Committed');
  });
});
