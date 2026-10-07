/**
 * Upgrade 058 → 059: every existing account that is not god gets its `member`
 * row in Casbin, and nothing else moves.
 *
 * Before 059 the engine read `"user".role` as a role in every domain, so an
 * account created by 058 has no `g <user> member *` row. 059 stops reading the
 * column as a role: without the backfill every such member would lose `member`
 * — and with it every row rule that restricts members. Planted here: an
 * account as 058 left it (column `member`, no row), a god (gets none), an
 * account that already holds the row (no duplicate), and one holding another
 * role (kept). The down step removes only the backfilled rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile } from '../../db/migrations/index.js';
import {
  clearLocalPermissionCache,
  getEnforcer,
  getUserRoles,
} from '../../lib/tenancy/permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const OLD = `m059-old-${STAMP}`;
const HELD = `m059-held-${STAMP}`;
const OTHER = `m059-other-${STAMP}`;
const USERS = [OLD, HELD, OTHER];

async function rows(db: Database, user: string): Promise<string[]> {
  const r = await sql<{ v1: string; v2: string }>`
    SELECT v1, v2 FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${user} ORDER BY v1, v2
  `.execute(db);
  return r.rows.map((x) => `${x.v1}@${x.v2}`);
}

d('migration 059 backfills `member` into Casbin', () => {
  let db: Database;
  let up = '';
  let down = '';
  // The instance holds exactly one god (a trigger refuses a second): use it.
  let god = '';

  beforeAll(async () => {
    const { app, ...rest } = await getTestApp();
    db = rest.db;
    await createGodSession(app, db);
    god = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db)).rows[0]!
      .id;
    // As 058 left it: no row for the god either.
    await sql`DELETE FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${god} AND v1 = 'member'`.execute(
      db,
    );
    const file = Bun.file(
      new URL('../../db/migrations/sql/059_member_role_in_casbin.sql', import.meta.url),
    );
    const parsed = parseMigrationFile(await file.text());
    up = parsed.up;
    down = parsed.down ?? '';

    for (const id of USERS) {
      await sql`
        INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
        VALUES (${id}, ${id}, ${`${id}@probe.invalid`}, false,
                'member', now(), now())
      `.execute(db);
    }
    // As 058 left them: no row for OLD, the row already there for HELD,
    // another role only for OTHER. 059's trigger gave each one at INSERT.
    await sql`DELETE FROM zvd_permissions WHERE v0 = ANY(${USERS})`.execute(db);
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES
        ('g', ${HELD}, 'member', '*'),
        ('g', ${OTHER}, 'editor', '*')
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    // `down` ran on the shared harness DB: give every other account its row back.
    if (up) await sql.raw(up).execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v0 = ANY(${USERS})`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ANY(${USERS})`.execute(db);
    clearLocalPermissionCache();
  });

  it('the premise: an account 058 created holds no `member` row', async () => {
    expect(await rows(db, OLD)).toEqual([]);
  });

  it('up gives every non-god account exactly one `member` row and keeps the rest', async () => {
    await sql.raw(up).execute(db);
    expect(await rows(db, OLD)).toEqual(['member@*']);
    expect((await rows(db, god)).filter((r) => r.startsWith('member@'))).toEqual([]);
    expect(await rows(db, HELD)).toEqual(['member@*']);
    expect(await rows(db, OTHER)).toEqual(['editor@*', 'member@*']);
  });

  it('up is re-runnable', async () => {
    await sql.raw(up).execute(db);
    expect(await rows(db, OLD)).toEqual(['member@*']);
    expect(await rows(db, HELD)).toEqual(['member@*']);
  });

  it('the engine reads the backfilled row as `member`', async () => {
    // The model loaded before the backfill: the row comes from the table.
    expect((await getEnforcer()).getModel().getFilteredPolicy('g', 'g', 0, OLD)).toEqual([]);
    clearLocalPermissionCache();
    expect(await getUserRoles(OLD)).toContain('member');
  });

  it('down removes the `member` rows and the trigger, and nothing else', async () => {
    await sql.raw(down).execute(db);
    expect(await rows(db, OLD)).toEqual([]);
    expect(await rows(db, HELD)).toEqual([]);
    expect(await rows(db, OTHER)).toEqual(['editor@*']);
    const triggers = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM pg_trigger
       WHERE tgrelid = '"user"'::regclass AND tgname LIKE 'zv_grant_member_role%'`.execute(db);
    expect(triggers.rows[0]?.n).toBe(0);
  });
});
