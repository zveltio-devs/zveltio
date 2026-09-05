/**
 * A privileged write on the tenant surface leaves a trace.
 *
 * `routes/tenants.ts` held no audit call at all — 453 lines that create firms,
 * suspend them, grant somebody `tenant_owner` inside one and take it away again,
 * with nothing written down. Meanwhile `routes/permissions.ts` audited the same
 * act on its own endpoint: one act, two routes, one of them invisible.
 *
 * The cases below drive the real routes and read `zv_audit_log`, because a test
 * that asserts the function was called would pass against a call that writes a
 * row Postgres rejects — which is how this table ended up holding rows nobody
 * could query before migration 041.
 */
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('tenant routes write an audit trail (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  const tag = crypto.randomUUID().slice(0, 8);
  const slug = `audit-probe-${tag}`;
  const memberEmail = `audit-member-${tag}@test.local`;
  let tenantId = '';
  let memberId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    memberId = `audit-user-${tag}`;
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
      VALUES (${memberId}, 'Audit Probe', ${memberEmail}, false, 'member', NOW(), NOW())
    `.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${memberId}`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ${memberId}`.execute(db);
    if (tenantId) {
      await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${tenantId}`.execute(db);
      await sql`DELETE FROM zv_audit_log WHERE resource_id = ${tenantId}`.execute(db);
      await sql`DELETE FROM zv_tenants WHERE id = ${tenantId}`.execute(db);
    }
  });

  /** Audit rows of one type, most recent first, read back as stored. */
  async function events(type: string): Promise<Array<Record<string, unknown>>> {
    const r = await sql<{ metadata: unknown; resource_id: string | null }>`
      SELECT metadata, resource_id FROM zv_audit_log
       WHERE event_type = ${type}
       ORDER BY created_at DESC
       LIMIT 5
    `.execute(db);
    return r.rows as unknown as Array<Record<string, unknown>>;
  }

  it('records the creation of a tenant', async () => {
    const res = await app.request('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        slug,
        name: `Audit Probe ${tag}`,
        admin_user_email: memberEmail,
      }),
    });
    expect(res.status).toBe(201);
    tenantId = ((await res.json()) as { tenant: { id: string } }).tenant.id;

    const rows = await events('tenant.created');
    expect(rows.some((r) => r.resource_id === tenantId)).toBe(true);
  });

  it('records who was given a role inside it, and who lost one', async () => {
    const added = await app.request(`/api/tenants/${tenantId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ user_email: memberEmail, role: 'admin' }),
    });
    expect(added.status).toBe(201);

    const addRows = await events('tenant.member_added');
    const add = addRows.find((r) => r.resource_id === memberId);
    expect(add).toBeDefined();
    // Queryable, not a JSON string: migration 041 exists because these rows were
    // written in a shape that answered NULL to every `metadata->>'…'`.
    const meta = add?.metadata as Record<string, unknown>;
    expect(meta?.role).toBe('admin');
    expect(meta?.tenant_id).toBe(tenantId);

    const removed = await app.request(`/api/tenants/${tenantId}/members/${memberId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(removed.status).toBe(200);
    expect((await events('tenant.member_removed')).some((r) => r.resource_id === memberId)).toBe(
      true,
    );
  });

  it('records a suspension by name, not just that something changed', async () => {
    const res = await app.request(`/api/tenants/${tenantId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ status: 'suspended' }),
    });
    expect(res.status).toBe(200);

    const row = (await events('tenant.updated')).find((r) => r.resource_id === tenantId);
    expect(row).toBeDefined();
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta?.status).toBe('suspended');
    expect(meta?.fields).toContain('status');
  });
});
