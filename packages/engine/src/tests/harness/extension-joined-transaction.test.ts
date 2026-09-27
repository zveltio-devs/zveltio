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

import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { getCurrentTenantTrx } from '../../lib/tenancy/index.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';

d("an extension's joined transaction", () => {
  let db: Database;
  let userId: string;
  // The handle production gives an extension: the current request transaction.
  const extDb = () => createRestrictedDb(() => getCurrentTenantTrx() ?? db, 'probe');
  const nameOf = async () =>
    (await sql<{ name: string }>`SELECT name FROM "user" WHERE id = ${userId}`.execute(db)).rows[0]!
      .name;

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    ({ userId } = await createMemberSession(t.app, db));
    await sql`UPDATE "user" SET name = 'Before' WHERE id = ${userId}`.execute(db);
  });

  it('rolls its own writes back on a throw, and the request still commits the rest', async () => {
    await buildExtensionInternals().withTenantIsolation(TENANT, async (trx) => {
      await expect(
        extDb()
          .transaction()
          .execute(async (t) => {
            await sql`UPDATE "user" SET name = 'Inside' WHERE id = ${userId}`.execute(t);
            throw new Error('refused half-way');
          }),
      ).rejects.toThrow('refused half-way');
      // The request carries on and writes after the failed block.
      await sql`UPDATE "user" SET "emailVerified" = true WHERE id = ${userId}`.execute(trx);
    });

    expect(await nameOf()).toBe('Before');
    const v = await sql<{ ok: boolean }>`
      SELECT "emailVerified" AS ok FROM "user" WHERE id = ${userId}`.execute(db);
    expect(v.rows[0]!.ok).toBe(true);
  });

  it('commits with the request when the block succeeds', async () => {
    await buildExtensionInternals().withTenantIsolation(TENANT, () =>
      extDb()
        .transaction()
        .execute(async (t) => {
          await sql`UPDATE "user" SET name = 'Committed' WHERE id = ${userId}`.execute(t);
        }),
    );
    expect(await nameOf()).toBe('Committed');
  });
});
