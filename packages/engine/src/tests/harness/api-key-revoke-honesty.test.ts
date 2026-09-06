/**
 * A revocation that revoked nothing must not answer "done".
 *
 * Both API-key surfaces — `/api/admin/api-keys/:id` and `/api/api-keys/:id`,
 * twins with the same body — returned `{ success: true }` unconditionally. An id
 * that does not exist, or one belonging to another firm (the tenant predicate is
 * deliberate and stays), answered success while the key stayed live.
 *
 * On a revocation that is the dangerous direction to be wrong in: an
 * administrator who believes a leaked credential is dead stops looking for it.
 * The audit entry moved below the check for the same reason — a trail of
 * revocations that did not happen is worse than a gap, because it is read as
 * evidence.
 */
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('revoking an API key reports what it did (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const made: string[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    for (const id of made) {
      await sql`DELETE FROM zv_api_keys WHERE id = ${id}`.execute(db);
    }
    await sql`DELETE FROM zv_audit_log WHERE resource_type = 'api_key'`.execute(db);
  });

  async function mint(name: string): Promise<string> {
    const res = await app.request('/api/admin/api-keys', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(200);
    const id = ((await res.json()) as { id: string }).id;
    made.push(id);
    return id;
  }

  it.each(['/api/admin/api-keys', '/api/api-keys'])(
    'answers 404 from %s when nothing matched',
    async (base) => {
      const res = await app.request(`${base}/${crypto.randomUUID()}`, {
        method: 'DELETE',
        headers: { cookie },
      });
      expect(res.status).toBe(404);
    },
  );

  it('writes no audit entry for a revocation that did not happen', async () => {
    const before = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log WHERE event_type = 'api_key.revoked'
    `.execute(db);
    await app.request(`/api/admin/api-keys/${crypto.randomUUID()}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    const after = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log WHERE event_type = 'api_key.revoked'
    `.execute(db);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('still revokes a real key, and records that one', async () => {
    // The obvious mistake in the other direction: a guard strict enough to stop
    // revocation working at all.
    const id = await mint('revoke-honesty-probe');
    const res = await app.request(`/api/admin/api-keys/${id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    const row = await sql<{ is_active: boolean }>`
      SELECT is_active FROM zv_api_keys WHERE id = ${id}
    `.execute(db);
    expect(row.rows[0]?.is_active).toBe(false);

    const audited = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log
       WHERE event_type = 'api_key.revoked' AND resource_id = ${id}
    `.execute(db);
    expect(audited.rows[0]!.n).toBe(1);
  });
});
