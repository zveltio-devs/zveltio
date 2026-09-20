/**
 * What `POST /api/sync/push` enforces, and what it reports.
 *
 * Three defects, each measured on this harness before the repair:
 *
 * - a column a role may not write through `/api/data` was writable through the
 *   push path: `PATCH` answered 403 and left the value alone, the push wrote it;
 * - one failing operation aborted the request's Postgres transaction, so every
 *   later operation in the same push answered `25P02 current transaction is
 *   aborted` and was lost — a batch is capped at 500, so one bad row took 499
 *   good ones with it;
 * - the Electric token's `tenant_id` claim came from `user.tenantId`, a property
 *   better-auth never sets, so it was never emitted at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLUMNS = `hpushcol_${Date.now()}`;
const A = `hpusha_${Date.now()}`;
const B = `hpushb_${Date.now()}`;

d('sync push guards (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let memberId = '';
  let recordId = '';

  const push = (cookie: string, operations: unknown[]) =>
    app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ operations }),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);

    await DDLManager.createCollection(db, {
      name: COLUMNS,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'salary', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    for (const name of [A, B]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'code', type: 'text', required: true, unique: true, indexed: true }],
      } as never);
    }

    const created = await app.request(`/api/data/${COLUMNS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ title: 'row', salary: '100' }),
    });
    recordId = ((await created.json()) as { id?: string }).id ?? '';
    await app.request(`/api/data/${A}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ code: 'TAKEN' }),
    });

    const email = `harness-push-${Date.now()}@test.local`;
    const password = 'MemberUser123!';
    const signUp = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Member' }),
    });
    memberId = ((await signUp.json()) as { user?: { id: string } }).user?.id ?? '';
    await sql`UPDATE "user" SET role = 'member' WHERE id = ${memberId}`.execute(db);
    const enforcer = await getEnforcer();
    await enforcer.addPolicy(memberId, '*', `data:${COLUMNS}`, 'read');
    await enforcer.addPolicy(memberId, '*', `data:${COLUMNS}`, 'update');
    await invalidateUserPermCache(memberId);
    const signIn = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    memberCookie = (signIn.headers.get('set-cookie') ?? '')
      .split(',')
      .map((c) => c.split(';')[0]!.trim())
      .filter(Boolean)
      .join('; ');

    await app.request('/api/admin/column-permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection_name: COLUMNS,
        column_name: 'salary',
        role: 'member',
        can_read: true,
        can_write: false,
      }),
    });
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLUMNS}`
      .execute(db)
      .catch(() => {});
    if (memberId) {
      const enforcer = await getEnforcer();
      await enforcer.removePolicy(memberId, '*', `data:${COLUMNS}`, 'read').catch(() => {});
      await enforcer.removePolicy(memberId, '*', `data:${COLUMNS}`, 'update').catch(() => {});
    }
    for (const name of [COLUMNS, A, B]) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${name}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db.deleteFrom('zvd_collections').where('name', '=', name).execute().catch(() => {});
    }
  });

  it('refuses a column the role may not write, exactly as PATCH does', async () => {
    const patched = await app.request(`/api/data/${COLUMNS}/${recordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ salary: 'API-999' }),
    });
    expect(patched.status).toBe(403);

    const res = await push(memberCookie, [
      { collection: COLUMNS, recordId, operation: 'update', payload: { salary: 'SYNC-999' } },
    ]);
    const body = (await res.json()) as { results: { status: string; error?: string }[] };
    expect(body.results[0]?.status).toBe('error');
    expect(body.results[0]?.error).toMatch(/read-only for your role/);

    const row = await sql<{ salary: string }>`
      SELECT salary FROM ${sql.id(`zvd_${COLUMNS}`)} WHERE id = ${recordId}
    `.execute(db);
    expect(row.rows[0]?.salary).toBe('100');
  });

  it('a failing operation does not take the rest of the push with it', async () => {
    const goodId = crypto.randomUUID();
    const res = await push(godCookie, [
      { collection: A, recordId: crypto.randomUUID(), operation: 'create', payload: { code: 'TAKEN' } },
      { collection: B, recordId: goodId, operation: 'create', payload: { code: 'FRESH' } },
    ]);
    const body = (await res.json()) as { results: { status: string; error?: string }[] };
    expect(body.results[0]?.status).toBe('error');
    expect(body.results[0]?.error).toMatch(/duplicate key/);
    // The second operation must not be blamed for the first one's failure.
    expect(body.results[1]?.error ?? '').not.toMatch(/transaction is aborted/);
    expect(body.results[1]?.status).toBe('ok');

    const written = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.id(`zvd_${B}`)} WHERE id = ${goodId}
    `.execute(db);
    expect(written.rows[0]?.n).toBe(1);
  });

  it('the Electric token carries the request tenant', async () => {
    process.env.ELECTRIC_URL = 'wss://electric.test:5133';
    process.env.ELECTRIC_AUTH_TOKEN = 'harness-shared-secret';
    const res = await app.request('/api/electric/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {
      tenant_id?: string;
    };
    expect(claims.tenant_id).toBeTruthy();
  });
});
