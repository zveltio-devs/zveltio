/**
 * `ctx.internals.exportUserData` — a data-subject access request (GDPR art. 15)
 * answered from the engine's own tables.
 *
 * compliance/gdpr read `"user"`, `zv_audit_log`, `zv_notifications`,
 * `zv_api_keys` and `zv_approval_requests` with raw SQL through `ctx.db`, which
 * #858 refuses to an extension, so `/export-my-data` answered 500. Even before
 * that, a read in the request's tenant left out the user's sign-ins (audit
 * rows with no tenant) and everything another tenant recorded about them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { CapabilityDeniedError, gateInternals } from '../../lib/extensions/capabilities.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import {
  asEveryTenant,
  asTenant,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `${Date.now()}`.slice(-12).padStart(12, '0');
const T = `00000000-0000-0000-0e18-${TAG}`;
const USER = `export-${TAG}`;
const OTHER = `export-other-${TAG}`;

d('ctx.internals.exportUserData', () => {
  let db: Database;
  const gdpr = gateInternals('compliance/gdpr', buildExtensionInternals(), ['auth:users']);
  const bare = gateInternals('compliance/gdpr', buildExtensionInternals(), []);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${T}::uuid, ${`export-${TAG}`}, 'export', 'active')`.execute(db);
    for (const id of [USER, OTHER]) {
      await sql`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
                VALUES (${id}, ${id}, ${`${id}@test.local`}, true, 'member', now(), now())`.execute(
        db,
      );
    }
    // One audit row in each place a user's actions are recorded: the default
    // tenant, another tenant, and the instance level (no tenant).
    // Each row as its own tenant, the instance's outside any: FORCE RLS binds
    // the owner role a real install runs as.
    await asTenant(db, DEFAULT_TENANT_ID, (trx) =>
      sql`INSERT INTO zv_audit_log (event_type, user_id, resource_type, tenant_id) VALUES
                ('export.default', ${USER}, 'x', ${DEFAULT_TENANT_ID}::uuid)`.execute(trx),
    );
    await asTenant(db, T, (trx) =>
      sql`INSERT INTO zv_audit_log (event_type, user_id, resource_type, tenant_id) VALUES
                ('export.other', ${USER}, 'x', ${T}::uuid),
                ('export.someone_else', ${OTHER}, 'x', ${T}::uuid)`.execute(trx),
    );
    await sql`INSERT INTO zv_audit_log (event_type, user_id, resource_type, tenant_id)
              VALUES ('export.instance', ${USER}, 'x', NULL)`.execute(db);
    await sql`INSERT INTO zv_notifications (user_id, title, message) VALUES
                (${USER}, 'mine', 'm'), (${OTHER}, 'theirs', 't')`.execute(db);
    await sql`INSERT INTO zv_api_keys (name, key_hash, key_prefix, created_by, tenant_id)
              VALUES ('my-key', ${`h-${TAG}`}, 'zvk_x', ${USER}, '00000000-0000-0000-0000-000000000001'::uuid),
                     ('my-other-key', ${`h2-${TAG}`}, 'zvk_y', ${USER}, ${T}::uuid)`.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_audit_log WHERE user_id IN (${USER}, ${OTHER})`.execute(trx),
    );
    await sql`DELETE FROM zv_api_keys WHERE key_hash IN (${`h-${TAG}`}, ${`h2-${TAG}`})`.execute(
      db,
    );
    await sql`DELETE FROM "user" WHERE id IN (${USER}, ${OTHER})`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${T}::uuid`.execute(db);
  });

  it("returns the user's own rows from every tenant and the instance, and nobody else's", async () => {
    const out = await gdpr.exportUserData(USER);
    expect(out?.profile).toMatchObject({ id: USER, email: `${USER}@test.local` });
    expect(out!.audit_log.map((r) => r.action).sort()).toEqual([
      'export.default',
      'export.instance',
      'export.other',
    ]);
    expect(out!.notifications.map((n) => n.title)).toEqual(['mine']);
    // Keys in every tenant, not only the one a request would act in (065).
    expect(out!.api_keys.map((k) => k.name).sort()).toEqual(['my-key', 'my-other-key']);
    expect(JSON.stringify(out)).not.toContain(`h-${TAG}`);
  });

  it('answers null for no such user', async () => {
    expect(await gdpr.exportUserData(`nobody-${TAG}`)).toBeNull();
  });

  it('is gated auth:users', () => {
    expect(() => bare.exportUserData(USER)).toThrow(CapabilityDeniedError);
  });
});
