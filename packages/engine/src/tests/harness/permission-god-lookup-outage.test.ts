/**
 * A god lookup that fails is not "not god".
 *
 * `isGodUser` answers `false` when the database cannot be read, and that is the
 * right answer for a gate: nobody is granted god on a guess. But `checkPermission`
 * passed that `false` on as a DENY, so a god who holds no explicit Casbin grant
 * — god needs none — read as forbidden during a database blip. The realtime
 * sweeps treat a throw as "lookup failed, keep and retry" and a `false` as a
 * revoke, so every open god stream was ended by an outage.
 *
 * The outage here is real: the `"user"` table is renamed away for the duration,
 * so the god lookup's own query fails the way it would with the table unreadable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { checkPermission, clearLocalPermissionCache } from '../../lib/tenancy/index.js';
import { runWithDomain } from '../../lib/tenancy/tenant-context.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';
import { _sseConnectionsForTests, revalidateSseStreams } from '../../routes/realtime.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `godout_${Date.now()}`;
// Rendered as 503 + Retry-After: "cannot check now, retry", not a refusal.
const UNAVAILABLE = { status: 503, code: 'permission.unavailable', retryAfter: 5 };

d('a god lookup that fails', () => {
  let app: Hono;
  let db: Database;
  let godCookie: string;
  let godId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    godId = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]!.id;
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (db) await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  /** Run `fn` with the god lookup's query failing, and nothing cached to hide it. */
  async function duringOutage<T>(fn: () => Promise<T>): Promise<T> {
    await sql`ALTER TABLE "user" RENAME TO "user_outage"`.execute(db);
    try {
      clearLocalPermissionCache();
      return await fn();
    } finally {
      await sql`ALTER TABLE "user_outage" RENAME TO "user"`.execute(db);
      clearLocalPermissionCache();
    }
  }

  const check = (user: string, resource: string) =>
    runWithDomain(DEFAULT_TENANT_ID, () => checkPermission(user, resource, 'read'));

  it('keeps an open god stream; the sweep reports a failed lookup instead of a revoke', async () => {
    const res = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { cookie: godCookie },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // `connected`
    const open = () => (_sseConnectionsForTests().get(godId)?.size ?? 0) > 0;
    expect(open()).toBe(true);
    try {
      const failed = await duringOutage(() => revalidateSseStreams());
      expect(open()).toBe(true);
      expect(failed).toBe(true);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it('never answers yes on the request path: unknown god throws, a real grant still holds', async () => {
    const member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection: COLLECTION, actions: ['read'] }],
    });
    await duringOutage(async () => {
      // A god with no explicit grant: not provably allowed, not provably denied.
      await expect(check(godId, COLLECTION)).rejects.toMatchObject(UNAVAILABLE);
      // A member without a grant: same — the refusal is an error, never a yes.
      await expect(check(member.userId, `nothing_${COLLECTION}`)).rejects.toMatchObject(
        UNAVAILABLE,
      );
      // A grant Casbin holds does not depend on the god lookup at all.
      expect(await check(member.userId, COLLECTION)).toBe(true);
    });
    // Recovered: the god is god again.
    expect(await check(godId, COLLECTION)).toBe(true);
  });
});
