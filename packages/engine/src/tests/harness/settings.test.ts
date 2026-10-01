/**
 * Phase C — /api/settings (routes/settings.ts public + admin upsert paths).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const KEY = `site_name_harness_${Date.now()}`;

d('settings routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db) {
      await db
        .deleteFrom('zv_settings')
        .where('key', 'in', ['site_name', 'smtp_pass', 'company_name', 'smtp_host'])
        .execute()
        .catch(() => {});
    }
  });

  it('GET /api/settings/public returns whitelisted public settings', async () => {
    // Three rows, one per guard: public and whitelisted (served), public but
    // not whitelisted (a secret someone flagged public), whitelisted but not
    // public. Only the first may come back.
    await sql`
      INSERT INTO zv_settings (key, value, is_public, updated_at) VALUES
        ('site_name', ${JSON.stringify(KEY)}::jsonb, true, now()),
        ('smtp_pass', '"leaked-if-served"'::jsonb, true, now()),
        ('company_name', '"private-co"'::jsonb, false, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, is_public = EXCLUDED.is_public
    `.execute(db);

    const res = await app.request('/api/settings/public');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.site_name).toBe(KEY);
    expect(body).not.toHaveProperty('smtp_pass');
    expect(body).not.toHaveProperty('company_name');
    expect(typeof body.registration_enabled).toBe('boolean');

    await sql`DELETE FROM zv_settings WHERE key IN ('smtp_pass', 'company_name')`.execute(db);
  });

  it('never returns a secret setting in plaintext, on any read or write path', async () => {
    const secret = `hunter2-${Date.now()}`;
    const put = await app.request('/api/settings/smtp_pass', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ value: secret }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { value: unknown }).value).toBe('********');

    const list = await app.request('/api/settings', { headers: { cookie } });
    expect(((await list.json()) as Record<string, unknown>).smtp_pass).toBe('********');

    // The single-key read handed back the plaintext the list had stopped
    // disclosing.
    const one = await app.request('/api/settings/smtp_pass', { headers: { cookie } });
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ key: 'smtp_pass', value: '********' });

    // Saving the form unchanged sends the mask back; that must not overwrite
    // the stored secret with eight asterisks.
    const resave = await app.request('/api/settings/smtp_pass', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ value: '********' }),
    });
    expect(resave.status).toBe(200);
    const stored = await sql<{ value: unknown }>`
      SELECT value FROM zv_settings WHERE key = 'smtp_pass'
    `.execute(db);
    expect(stored.rows[0]?.value).toBe(secret);

    // A non-secret key still reads back as itself.
    await app.request('/api/settings/smtp_host', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ value: 'smtp.example.test' }),
    });
    const host = await app.request('/api/settings/smtp_host', { headers: { cookie } });
    expect(await host.json()).toEqual({ key: 'smtp_host', value: 'smtp.example.test' });
  });

  it('GET /api/settings lists all settings for admins', async () => {
    const res = await app.request('/api/settings', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  it('PUT /api/settings/:key upserts a writable setting', async () => {
    const res = await app.request('/api/settings/site_name', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ value: KEY, is_public: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; value: string };
    expect(body.success).toBe(true);
    expect(body.value).toBe(KEY);
  });

  it('PATCH /api/settings/bulk updates multiple writable keys', async () => {
    const res = await app.request('/api/settings/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ timezone: 'UTC', language: 'en' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; updated: string[] };
    expect(body.success).toBe(true);
    expect(body.updated).toContain('timezone');
  });

  it('rejects writes to readonly settings keys', async () => {
    const res = await app.request('/api/settings/auth_secret', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ value: 'nope' }),
    });
    expect(res.status).toBe(403);
  });
});
