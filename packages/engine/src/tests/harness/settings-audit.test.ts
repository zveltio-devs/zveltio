/**
 * Changing an instance setting leaves a trace, and the trace does not carry the
 * value.
 *
 * `routes/settings.ts` held no audit call at all — the same shape `routes/
 * tenants.ts` had before #463. Its writable set includes `registration_enabled`,
 * the flag deciding whether anyone on the internet may create an account, listed
 * under a comment reading "Feature toggles (non-security)". Turning that on left
 * no trace anywhere.
 *
 * The value is deliberately absent from the entry: the same writable set carries
 * `smtp_host` and its neighbours, and the audit table is readable by anyone who
 * can read the audit table.
 */
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('settings writes are audited (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_audit_log WHERE resource_type = 'setting'`.execute(db);
  });

  async function entries(): Promise<Array<Record<string, unknown>>> {
    const r = await sql<{ metadata: unknown; user_id: string | null }>`
      SELECT metadata, user_id FROM zv_audit_log
       WHERE resource_type = 'setting' ORDER BY created_at DESC LIMIT 5
    `.execute(db);
    return r.rows as unknown as Array<Record<string, unknown>>;
  }

  it('records a single-key write, naming the key and the actor', async () => {
    const res = await app.request('/api/settings/app_name', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ value: 'Audited Instance' }),
    });
    expect(res.status).toBe(200);

    const row = (await entries())[0];
    expect(row).toBeDefined();
    expect((row?.metadata as Record<string, unknown>)?.key).toBe('app_name');
    // The guard resolved the session; the entry has to say who it was.
    expect(row?.user_id).toBeTruthy();
  });

  it('does not put the value in the trail', async () => {
    const secretish = `smtp.probe-${crypto.randomUUID().slice(0, 8)}.example`;
    const res = await app.request('/api/settings/smtp_host', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ value: secretish }),
    });
    expect(res.status).toBe(200);

    const rows = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log
       WHERE resource_type = 'setting' AND metadata::text LIKE ${`%${secretish}%`}
    `.execute(db);
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('records a bulk write by the keys it touched', async () => {
    const res = await app.request('/api/settings/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ app_name: 'Bulk Probe', timezone: 'Europe/Bucharest' }),
    });
    expect(res.status).toBe(200);

    const meta = (await entries())[0]?.metadata as Record<string, unknown>;
    expect(meta?.bulk).toBe(true);
    expect(meta?.keys).toEqual(['app_name', 'timezone']);
  });
});
