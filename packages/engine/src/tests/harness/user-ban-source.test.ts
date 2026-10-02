/**
 * Ban provenance (migration 035): `"user".ban_source` / `banned_at`, written by
 * `ctx.internals.setUserActive` as the CALLING extension, and `liftOwnBan`,
 * which lifts only the caller's own ban.
 *
 * Before, `banned` was a bare flag: an extension could not tell its ban from an
 * administrator's, so auth/scim kept a marker table and a trigger on "user".
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  getLastAppliedMigration,
  rollbackMigration,
  runPending,
} from '../../db/migrations/index.js';
import { CapabilityDeniedError, gateInternals } from '../../lib/extensions/capabilities.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';

d('ban provenance', () => {
  let app: Hono;
  let db: Database;
  const scim = gateInternals('auth/scim', buildExtensionInternals(), ['auth:users']);
  const ldap = gateInternals('auth/ldap', buildExtensionInternals(), ['auth:users']);
  const asRequest = <T>(fn: (trx: Database) => Promise<T>) =>
    buildExtensionInternals().withTenantIsolation(TENANT, fn);

  const ban = async (id: string) =>
    (
      await sql<{ banned: boolean | null; ban_source: string | null; banned_at: Date | null }>`
        SELECT banned, ban_source, banned_at FROM "user" WHERE id = ${id}`.execute(db)
    ).rows[0]!;
  const member = async () => (await createMemberSession(app, db)).userId;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
  });

  it('a ban records the calling extension and the time; only it can lift it', async () => {
    const id = await member();
    await asRequest((trx) => scim.setUserActive(trx, id, false));
    const placed = await ban(id);
    expect(placed).toMatchObject({ banned: true, ban_source: 'ext:auth/scim' });
    expect(placed.banned_at).toBeInstanceOf(Date);

    // Another extension: refused, even naming the owner in an extra argument.
    const forged = ldap.liftOwnBan as unknown as (...a: unknown[]) => Promise<boolean>;
    expect(await asRequest((trx) => forged(trx, id, 'ext:auth/scim'))).toBe(false);
    expect(await ban(id)).toMatchObject({ banned: true, ban_source: 'ext:auth/scim' });

    expect(await asRequest((trx) => scim.liftOwnBan(trx, id))).toBe(true);
    expect(await ban(id)).toEqual({ banned: false, ban_source: null, banned_at: null });
    // Nothing left to lift.
    expect(await asRequest((trx) => scim.liftOwnBan(trx, id))).toBe(false);
  });

  it('the first ban stands: a second extension banning keeps the source', async () => {
    const id = await member();
    await asRequest((trx) => scim.setUserActive(trx, id, false));
    const first = await ban(id);
    await asRequest((trx) => ldap.setUserActive(trx, id, false));
    expect(await ban(id)).toEqual(first);
    expect(await asRequest((trx) => ldap.liftOwnBan(trx, id))).toBe(false);
    expect((await ban(id)).banned).toBe(true);
  });

  it('setUserActive(true) lifts any ban and clears both columns', async () => {
    const id = await member();
    await sql`UPDATE "user" SET banned = true, ban_source = 'admin' WHERE id = ${id}`.execute(db);
    await asRequest((trx) => ldap.setUserActive(trx, id, true));
    expect(await ban(id)).toEqual({ banned: false, ban_source: null, banned_at: null });
  });

  it("a ban placed by hand or by an administrator is not an extension's to lift", async () => {
    const byHand = await member();
    await sql`UPDATE "user" SET banned = true WHERE id = ${byHand}`.execute(db);
    expect(await ban(byHand)).toMatchObject({ banned: true, ban_source: 'unknown' });
    expect((await ban(byHand)).banned_at).toBeInstanceOf(Date);
    expect(await asRequest((trx) => scim.liftOwnBan(trx, byHand))).toBe(false);

    const byAdmin = await member();
    await sql`UPDATE "user" SET banned = true, ban_source = 'admin' WHERE id = ${byAdmin}`.execute(
      db,
    );
    expect(await asRequest((trx) => scim.liftOwnBan(trx, byAdmin))).toBe(false);
    expect((await ban(byAdmin)).ban_source).toBe('admin');
  });

  it('a ban lifted by hand forgets its source, so a ban placed by hand after it is nobody’s', async () => {
    const id = await member();
    await asRequest((trx) => scim.setUserActive(trx, id, false));
    await sql`UPDATE "user" SET banned = false WHERE id = ${id}`.execute(db);
    expect(await ban(id)).toEqual({ banned: false, ban_source: null, banned_at: null });
    await sql`UPDATE "user" SET banned = true WHERE id = ${id}`.execute(db);
    expect((await ban(id)).ban_source).toBe('unknown');
    expect(await asRequest((trx) => scim.liftOwnBan(trx, id))).toBe(false);
  });

  it('a ban older than migration 035 keeps no time when it is placed again', async () => {
    const id = await member();
    // An old ban: banned, time never recorded.
    await sql`UPDATE "user" SET banned = true WHERE id = ${id}`.execute(db);
    await sql`UPDATE "user" SET banned_at = NULL WHERE id = ${id}`.execute(db);
    expect((await ban(id)).banned_at).toBeNull();
    // better-auth's admin plugin re-banning writes `banned = true` again; now()
    // would date the ban to the re-ban, which is a guess.
    await sql`UPDATE "user" SET banned = true WHERE id = ${id}`.execute(db);
    expect(await ban(id)).toEqual({ banned: true, ban_source: 'unknown', banned_at: null });
  });

  it('is gated auth:users, and has no caller outside the gate', async () => {
    const bare = gateInternals('compliance/gdpr', buildExtensionInternals(), ['database']);
    expect(() => bare.liftOwnBan(db, 'anyone')).toThrow(CapabilityDeniedError);
    expect(() => buildExtensionInternals().liftOwnBan(db, 'anyone')).toThrow('gateInternals');
    expect(() => buildExtensionInternals().setUserActive(db, 'anyone', false)).toThrow(
      'gateInternals',
    );
  });

  describe('migration 035 on an existing install', () => {
    let createdScimTable = false;
    afterAll(async () => {
      if (createdScimTable) await sql`DROP TABLE IF EXISTS zv_scim_sign_in_blocks`.execute(db);
    });

    it("backfills `unknown` for existing bans and SCIM's for the bans SCIM recorded", async () => {
      const version = await getLastAppliedMigration(db);
      expect(version).toBeGreaterThanOrEqual(35);
      const [scimBan, otherBan, free] = [await member(), await member(), await member()];

      expect(await rollbackMigration(db, 34)).toEqual({ success: true });
      const cols = await sql`SELECT 1 FROM information_schema.columns
                              WHERE table_name = 'user' AND column_name = 'ban_source'`.execute(db);
      expect(cols.rows).toHaveLength(0);

      // auth/scim ≤ 1.0.15's marker table (its migration 003), if not installed.
      const exists = await sql<{ t: string | null }>`
        SELECT to_regclass('public.zv_scim_sign_in_blocks')::text AS t`.execute(db);
      if (!exists.rows[0]!.t) {
        createdScimTable = true;
        await sql`CREATE TABLE zv_scim_sign_in_blocks (
                    user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
                    created_at timestamptz NOT NULL DEFAULT now())`.execute(db);
      }
      await sql`UPDATE "user" SET banned = true WHERE id IN (${scimBan}, ${otherBan})`.execute(db);
      // A marker for a user who is no longer banned converts to nothing.
      await sql`INSERT INTO zv_scim_sign_in_blocks (user_id) VALUES (${scimBan}), (${free})`.execute(
        db,
      );

      await runPending(db);
      expect(await getLastAppliedMigration(db)).toBe(version);

      expect(await ban(scimBan)).toEqual({
        banned: true,
        ban_source: 'ext:auth/scim',
        banned_at: null,
      });
      expect(await ban(otherBan)).toEqual({ banned: true, ban_source: 'unknown', banned_at: null });
      expect(await ban(free)).toEqual({ banned: null, ban_source: null, banned_at: null });
      expect(await asRequest((trx) => scim.liftOwnBan(trx, scimBan))).toBe(true);
      expect(await asRequest((trx) => scim.liftOwnBan(trx, otherBan))).toBe(false);
    }, 60_000);
  });
});
