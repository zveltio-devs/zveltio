/**
 * God is a decision the DATABASE enforces, not one the engine takes by stepping
 * around it.
 *
 * Until this landed, a god saw across firms by running on `poolDb`: the pool
 * connects as a superuser with `rolbypassrls`, so the policies were never
 * consulted. The privilege was not expressed anywhere — it was a way around the
 * thing that expresses privileges, and a handler that forgot its check on that
 * connection read every firm's rows with nothing downstream able to tell.
 *
 * Now the reach is published into `zveltio.visible_tenants`, the first branch of
 * the predicate every policy already evaluates. Same code path as everyone else,
 * and the ordinary request pays nothing: that GUC was always written, only its
 * contents differ.
 *
 * ── Why this shape and not the two obvious ones ───────────────
 *
 * Measured on 400 000 rows before choosing:
 *
 *   teach `zveltio_visible_tenants()` to expand to all firms   0,061 → 0,434 ms
 *     on EVERY ordinary request — the subquery stops the function inlining
 *   add `OR zveltio_is_god()` to 300+ policies                 +6 microseconds,
 *     but rewrites every policy in the instance
 *   publish the reach from the engine (this)                   no change at all
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const TABLE = `zvd_godcheck_${STAMP}`;

d('god is enforced by the database (in-process)', () => {
  let db: Database;
  let godId = '';
  let plainId = '';
  let tenantA = '';
  let tenantB = '';

  beforeAll(async () => {
    ({ db } = await getTestApp());

    tenantA = (
      await sql<{ id: string }>`SELECT id FROM zv_tenants ORDER BY created_at LIMIT 1`.execute(db)
    ).rows[0]!.id;
    tenantB = (
      await sql<{ id: string }>`
        INSERT INTO zv_tenants (name, slug) VALUES (${`B ${STAMP}`}, ${`b-${STAMP}`})
        RETURNING id
      `.execute(db)
    ).rows[0]!.id;

    // Two users: one god, one not. Both real rows — `isGodUser` reads the table.
    //
    // The harness has already made its own god, and there is one per instance.
    // Standing it down here is the same thing `createGodSession` does for each
    // suite, and it is the invariant this file is partly about.
    await sql`UPDATE "user" SET role = 'member' WHERE role = 'god'`.execute(db);
    godId = (
      await sql<{ id: string }>`
        INSERT INTO "user" (id, email, name, role, "emailVerified", "createdAt", "updatedAt")
        VALUES (${`god-${STAMP}`}, ${`god-${STAMP}@test.local`}, 'God', 'god', true, now(), now())
        RETURNING id
      `.execute(db)
    ).rows[0]!.id;
    plainId = (
      await sql<{ id: string }>`
        INSERT INTO "user" (id, email, name, role, "emailVerified", "createdAt", "updatedAt")
        VALUES (${`plain-${STAMP}`}, ${`plain-${STAMP}@test.local`}, 'Plain', 'member', true, now(), now())
        RETURNING id
      `.execute(db)
    ).rows[0]!.id;

    // A table shaped like a collection, with the same policy the reconciler
    // writes, so this measures the real predicate rather than a stand-in.
    await sql
      .raw(`
      CREATE TABLE ${TABLE} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        title text NOT NULL
      )
    `)
      .execute(db);
    await sql.raw(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`).execute(db);
    await sql
      .raw(
        `CREATE POLICY tenant_isolation ON ${TABLE} ` +
          `USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))`,
      )
      .execute(db);
    await sql.raw(`GRANT SELECT, INSERT ON ${TABLE} TO zveltio_rls`).execute(db);

    await sql
      .raw(
        `INSERT INTO ${TABLE} (tenant_id, title) VALUES ('${tenantA}', 'a'), ('${tenantB}', 'b')`,
      )
      .execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`)
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM "user" WHERE id IN (${godId}, ${plainId})`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${tenantB}`.execute(db).catch(() => {});
  });

  /** Rows visible inside a real request transaction for `userId`. */
  const seenBy = async (userId: string | null): Promise<string[]> =>
    withTenantIsolation(
      tenantA,
      async (trx) => {
        const r = await sql
          .raw<{ title: string }>(`SELECT title FROM ${TABLE} ORDER BY title`)
          .execute(trx);
        return r.rows.map((x) => x.title);
      },
      { userId },
    );

  it('a god sees both firms, through the policy', async () => {
    expect(await seenBy(godId)).toEqual(['a', 'b']);
  });

  it('an ordinary user sees only the firm of the request', async () => {
    expect(await seenBy(plainId)).toEqual(['a']);
  });

  it('a request with no user named sees only the firm of the request', async () => {
    // Background workers, boot reconcilers, API-key traffic. Publishing no set
    // is answered by the equality fallback inside the predicate — the narrow
    // answer, which is what it did before any of this existed.
    expect(await seenBy(null)).toEqual(['a']);
  });

  describe('exactly one god', () => {
    // The model is one god per instance. Nothing enforced it: `user.role` took
    // 'god' on any number of rows, and the only thing between an instance and a
    // second one was that nobody had made one.
    it('refuses a second god', async () => {
      let message = '';
      try {
        await sql`
          INSERT INTO "user" (id, email, name, role, "emailVerified", "createdAt", "updatedAt")
          VALUES (${`god2-${STAMP}`}, ${`god2-${STAMP}@test.local`}, 'God2', 'god', true, now(), now())
        `.execute(db);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('already has a god');
      const n = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM "user" WHERE role = 'god'
      `.execute(db);
      expect(Number(n.rows[0]!.n)).toBe(1);
    });

    it('refuses promoting a member to god while one exists', async () => {
      let message = '';
      try {
        await sql`UPDATE "user" SET role = 'god' WHERE id = ${plainId}`.execute(db);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('already has a god');
    });

    it('lets the existing god be updated without tripping over itself', async () => {
      // An UPDATE that leaves a god a god is not a second god — the obvious
      // trigger gets this wrong and locks the only account out of its own row.
      await sql`UPDATE "user" SET name = 'God renamed' WHERE id = ${godId}`.execute(db);
      await sql`UPDATE "user" SET role = 'god' WHERE id = ${godId}`.execute(db);
      const r = await sql<{ name: string }>`
        SELECT name FROM "user" WHERE id = ${godId}
      `.execute(db);
      expect(r.rows[0]!.name).toBe('God renamed');
    });
  });

  it("god's reach is published, not assumed — the database is what refuses", async () => {
    // Proof that the enforcement is the policy and not a check in the handler:
    // inside the SAME transaction, ask the database directly what it considers
    // visible. For a plain user it is one firm; for a god it is every firm.
    const visible = async (userId: string) =>
      withTenantIsolation(
        tenantA,
        async (trx) =>
          (
            await sql<{ n: string }>`
              SELECT cardinality(zveltio_visible_tenants())::text AS n
            `.execute(trx)
          ).rows[0]!.n,
        { userId },
      );
    expect(Number(await visible(plainId))).toBe(1);
    expect(Number(await visible(godId))).toBeGreaterThanOrEqual(2);
  });
});
