/**
 * A share link's token is stored as its digest, never as itself (079).
 *
 * `zv_media_shares.token` is the bearer secret of a public `/share/:token` link,
 * and the request role reads every column of the table: any SQL running as
 * `zveltio_rls` in a tenant (raw SQL, an extension's `ctx.db`, a flow, an
 * insight) listed the live links of every member of that tenant. Stored as
 * `sha256:<hex>` the column opens nothing, and presenting the digest as a token
 * does not match it either.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { rollbackMigration, runPending } from '../../db/migrations/index.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  asEveryTenant,
  asTenant,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = crypto.randomUUID();
const TAG = `mstok-${Date.now()}`;
const digest = (t: string) => `sha256:${new Bun.CryptoHasher('sha256').update(t).digest('hex')}`;

d('media share tokens at rest (079)', () => {
  let db: Database;
  let folder: string;

  const share = (token: string) =>
    asTenant(db, TENANT, (trx) =>
      sql`INSERT INTO zv_media_shares (folder_id, token, created_by, tenant_id)
          VALUES (${folder}::uuid, ${token}, ${TAG}, ${TENANT}::uuid)`.execute(trx),
    );
  // What the request role sees, the way any SQL in the tenant reads it.
  const tokensAsRequestRole = () =>
    withTenantIsolation(TENANT, async (trx) =>
      (
        await sql<{ token: string }>`
          SELECT token FROM zv_media_shares WHERE created_by = ${TAG} ORDER BY token`.execute(trx)
      ).rows.map((r) => r.token),
    );
  const tenantOf = async (token: string) =>
    (
      await sql<{
        t: string | null;
      }>`SELECT zveltio_media_share_tenant(${token})::text AS t`.execute(db)
    ).rows[0]?.t ?? null;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO "user" (id, name, email) VALUES (${TAG}, ${TAG}, ${`${TAG}@test.local`})`.execute(
      db,
    );
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${TENANT}::uuid, ${TAG}, ${TAG}, 'active')`.execute(db);
    folder = (
      await asTenant(db, TENANT, (trx) =>
        sql<{ id: string }>`INSERT INTO zv_media_folders (name, tenant_id)
                            VALUES (${TAG}, ${TENANT}::uuid) RETURNING id::text AS id`.execute(trx),
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    await asEveryTenant(db, async (trx) => {
      await sql`DELETE FROM zv_media_shares WHERE created_by = ${TAG}`.execute(trx);
      await sql`DELETE FROM zv_media_folders WHERE name = ${TAG}`.execute(trx);
    });
    await sql`DELETE FROM zv_tenants WHERE id = ${TENANT}::uuid`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ${TAG}`.execute(db);
  });

  it('the request role reads a digest, and only the token itself resolves the link', async () => {
    // Written the way storage/cloud wrote it before 079: the raw token.
    const raw = `${TAG}-new`;
    await share(raw);

    const seen = await tokensAsRequestRole();
    expect(seen).not.toContain(raw);
    expect(seen).toEqual([digest(raw)]);
    expect(await tenantOf(raw)).toBe(TENANT);
    // The digest is what a reader of the column holds: it must open nothing.
    expect(await tenantOf(digest(raw))).toBeNull();
  });

  it('links issued before 079 are hashed on migrate and keep resolving', async () => {
    const raw = `${TAG}-old`;
    try {
      await rollbackMigration(db, 78, { ignoreBaseline: true });
      await share(raw);
    } finally {
      // A failed seed must not leave the shared database at 078 for every later file.
      await runPending(db);
    }
    expect(await tokensAsRequestRole()).toContain(digest(raw));
    expect(await tokensAsRequestRole()).not.toContain(raw);
    expect(await tenantOf(raw)).toBe(TENANT);
  }, 120_000);
});
