/**
 * The media visibility rule keeps a reader inside the tenant it acts in, by
 * itself — not because every caller remembers a `where tenant_id`.
 *
 * `applyFileVisibility` narrowed by `visibility` and owner only, and
 * `mayReadFile` / the delete check looked at the same two things. The row
 * policy on `zv_media_files` does not make up for it: it reads
 * `zveltio_visible_tenants()`, which for a unit with `read_scope = 'subtree'`
 * is the unit AND everything below it (and for god, every firm). So inside a
 * real request transaction of the parent, a `visibility = 'tenant'` file of a
 * child unit matches the helper — the child's shared library shows up in the
 * parent's own listing — and only the route's hand-written predicate kept it
 * out. Measured here before the fix: the listing returned both files.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { applyFileVisibility, mayDeleteFile, mayReadFile } from '../../lib/media-visibility.js';
import { withTenantIsolation } from '../../lib/tenancy/tenant-manager.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const PARENT = crypto.randomUUID();
const CHILD = crypto.randomUUID();
/** Outside the parent's tree: what proves the row policy is binding at all. */
const STRANGER = crypto.randomUUID();
const USER = `mvis-${PARENT.slice(0, 8)}`;
const STAMP = `mvis-${Date.now()}`;

d('media visibility is tenant-bound', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`
      INSERT INTO zv_tenants (id, slug, name, parent_id) VALUES
        (${PARENT}::uuid, ${`${USER}-p`}, 'Parent', NULL),
        (${CHILD}::uuid,  ${`${USER}-c`}, 'Child',  ${PARENT}::uuid),
        (${STRANGER}::uuid, ${`${USER}-s`}, 'Stranger', NULL)`.execute(db);
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
      VALUES (${USER}, ${USER}, ${`${USER}@test.invalid`}, true, 'member', now(), now())`.execute(
      db,
    );
    await sql`
      INSERT INTO zv_tenant_users (tenant_id, user_id, role, read_scope, valid_from)
      VALUES (${PARENT}::uuid, ${USER}, 'member', 'subtree', now() - interval '1 day')`.execute(db);
    for (const tenant of [PARENT, CHILD, STRANGER]) {
      await sql`
        INSERT INTO zv_media_files (filename, original_name, mimetype, storage_path, tenant_id, visibility)
        VALUES (${STAMP}, ${STAMP}, 'text/plain', ${`harness/${STAMP}`}, ${tenant}::uuid, 'tenant')`.execute(
        db,
      );
    }
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_media_files WHERE filename = ${STAMP}`
      .execute(db)
      .catch(() => undefined);
    await sql`DELETE FROM zv_tenant_users WHERE user_id = ${USER}`
      .execute(db)
      .catch(() => undefined);
    await sql`DELETE FROM "user" WHERE id = ${USER}`.execute(db).catch(() => undefined);
    await sql`DELETE FROM zv_tenants WHERE id IN (${CHILD}::uuid, ${STRANGER}::uuid, ${PARENT}::uuid)`
      .execute(db)
      .catch(() => undefined);
  });

  /** The parent's request transaction, with the reach the middleware gives it. */
  const asParent = <T>(fn: (trx: Database) => Promise<T>) =>
    withTenantIsolation(PARENT, fn, { userId: USER });

  it("the row policy alone lets the parent read the child's file", async () => {
    // Why the helper must carry the predicate: RLS binds (the stranger's file
    // is gone) but its reach is the subtree, wider than one tenant.
    const tenants = await asParent((trx) =>
      trx.selectFrom('zv_media_files').select('tenant_id').where('filename', '=', STAMP).execute(),
    );
    expect(tenants.map((r) => r.tenant_id).sort()).toEqual([CHILD, PARENT].sort());
  });

  for (const isAdmin of [false, true]) {
    it(`a listing through the helper stays in the acting tenant (isAdmin=${isAdmin})`, async () => {
      const rows = await asParent((trx) =>
        applyFileVisibility(
          trx.selectFrom('zv_media_files').select('tenant_id').where('filename', '=', STAMP),
          USER,
          isAdmin,
          PARENT,
        ).execute(),
      );
      expect(rows.map((r) => r.tenant_id)).toEqual([PARENT]);
    });
  }

  it('a loaded row of another tenant is neither readable nor deletable, even for its owner or an admin', () => {
    const own = { tenant_id: CHILD, visibility: 'tenant', created_by: USER };
    expect(mayReadFile(own, USER, false, PARENT)).toBe(false);
    expect(mayReadFile(own, USER, true, PARENT)).toBe(false);
    expect(mayDeleteFile(own, USER, false, PARENT)).toBe(false);
    expect(mayDeleteFile(own, USER, true, PARENT)).toBe(false);
    // And inside its own tenant the ordinary rule still answers.
    expect(mayReadFile(own, 'someone-else', false, CHILD)).toBe(true);
    expect(mayDeleteFile(own, USER, false, CHILD)).toBe(true);
    expect(mayDeleteFile(own, 'someone-else', false, CHILD)).toBe(false);
    expect(mayDeleteFile(own, 'someone-else', true, CHILD)).toBe(true);
  });
});
