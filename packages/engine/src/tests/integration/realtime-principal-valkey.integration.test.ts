/**
 * The realtime principal recheck, where production keeps its sessions.
 *
 * With VALKEY_URL, better-auth is handed a `secondaryStorage` and writes a
 * session there and nowhere else, so a SQL read of `session` would call every
 * live session revoked; and the cached copy carries the user as they were at
 * sign-in, so reading `banned` from it would miss a deactivation. The harness
 * drops VALKEY_URL on purpose, so only this file exercises that path.
 *
 * Skipped without TEST_VALKEY_URL/VALKEY_URL or TEST_DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _internalForTests, getAuth, initAuth, revokeAllUserSessions } from '../../lib/auth.js';
import { stillAuthenticated } from '../../lib/data/index.js';
import { getCache, initCache } from '../../lib/runtime/index.js';
import { createMemberSession, getTestApp } from '../../testing/app-harness.js';

// CI exports TEST_VALKEY_URL; with VALKEY_URL alone these skipped there.
const VALKEY_URL = process.env.TEST_VALKEY_URL ?? process.env.VALKEY_URL;
const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!VALKEY_URL || !DB_URL)('realtime principal recheck (live Valkey)', () => {
  let app: Hono;
  let db: Database;
  let savedValkey: string | undefined;
  let savedAuth: ReturnType<typeof getAuth> | null = null;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    savedAuth = getAuth();
    savedValkey = process.env.VALKEY_URL;
    process.env.VALKEY_URL = VALKEY_URL;
    if (!getCache()) await initCache();
    // An instance built the way production builds it: with the cache.
    await initAuth(db);
  });

  afterAll(() => {
    _internalForTests.setAuthForTests(savedAuth);
    if (savedValkey === undefined) delete process.env.VALKEY_URL;
    else process.env.VALKEY_URL = savedValkey;
  });

  it('asks Valkey for the session and the table for the user', async () => {
    const { userId } = await createMemberSession(app, db);
    const ctx = await getAuth().$context;
    expect(ctx.secondaryStorage).toBeDefined();
    const session = await ctx.internalAdapter.createSession(userId);
    // Held only in the cache: a SQL lookup would see no session at all.
    const rows = await sql`SELECT 1 FROM session WHERE token = ${session.token}`.execute(db);
    expect(rows.rows).toHaveLength(0);

    const p = { kind: 'session', token: session.token, userId } as const;
    const live = async () => (await stillAuthenticated(db, [p])).live.has(p);
    expect(await live()).toBe(true);

    // The cached copy still says the user is active; the table does not.
    await sql`UPDATE "user" SET banned = true WHERE id = ${userId}`.execute(db);
    expect(await live()).toBe(false);
    await sql`UPDATE "user" SET banned = false WHERE id = ${userId}`.execute(db);
    expect(await live()).toBe(true);

    await revokeAllUserSessions(db, userId);
    expect(await live()).toBe(false);
  });
});
