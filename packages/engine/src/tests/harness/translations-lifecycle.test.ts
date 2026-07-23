/**
 * Phase C — translations routes: locale + key + value lifecycle, approval,
 * glossary and coverage/missing stats. Drives routes/translations.ts
 * through the in-process app with a god session.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const LOCALE = 'tz';
const KEY = `harness.test.${Date.now()}`;

d('translations lifecycle (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let keyId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    if (keyId) {
      await sql`DELETE FROM zvd_translations WHERE key_id = ${keyId}`.execute(db).catch(() => {});
      await sql`DELETE FROM zvd_translation_keys WHERE id = ${keyId}`.execute(db).catch(() => {});
    }
    await sql`DELETE FROM zvd_locales WHERE code = ${LOCALE}`.execute(db).catch(() => {});
    await sql`DELETE FROM zvd_translation_glossary WHERE term = 'HarnessTerm'`
      .execute(db)
      .catch(() => {});
  });

  it('creates a locale (POST /locales)', async () => {
    const res = await app.request(
      '/api/translations/locales',
      json('POST', { code: LOCALE, name: 'Testish' }),
    );
    expect([200, 201]).toContain(res.status);
  });

  it('lists locales (GET /locales)', async () => {
    const res = await app.request('/api/translations/locales', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('creates a translation key (POST /)', async () => {
    const res = await app.request(
      '/api/translations',
      json('POST', { key: KEY, default_value: 'Hello', tags: ['harness'] }),
    );
    expect([200, 201]).toContain(res.status);
    keyId = ((await res.json()) as { key: { id: string } }).key.id;
    expect(keyId).toBeTruthy();
  });

  it('reads the key (GET /:keyId)', async () => {
    const res = await app.request(`/api/translations/${keyId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('sets a translation value (PUT /:keyId/:locale)', async () => {
    const res = await app.request(
      `/api/translations/${keyId}/${LOCALE}`,
      json('PUT', { value: 'Salut' }),
    );
    expect([200, 201]).toContain(res.status);
  });

  it('approves the value (POST /:keyId/:locale/approve)', async () => {
    const res = await app.request(`/api/translations/${keyId}/${LOCALE}/approve`, {
      method: 'POST',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
  });

  it('reports coverage stats (GET /stats/coverage)', async () => {
    const res = await app.request('/api/translations/stats/coverage', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('reports missing keys for a locale (GET /stats/missing/:locale)', async () => {
    const res = await app.request(`/api/translations/stats/missing/${LOCALE}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  });

  it('serves the public bundle (GET /public/:locale)', async () => {
    const res = await app.request(`/api/translations/public/${LOCALE}`);
    expect(res.status).toBe(200);
  });

  it('adds a glossary term (POST /glossary)', async () => {
    const res = await app.request(
      '/api/translations/glossary',
      json('POST', { term: 'HarnessTerm', locale: LOCALE, translation: 'TermenHarness' }),
    );
    expect([200, 201]).toContain(res.status);
  });

  it('lists glossary (GET /glossary)', async () => {
    const res = await app.request('/api/translations/glossary', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('deletes the translation value (DELETE /:keyId/:locale)', async () => {
    const res = await app.request(`/api/translations/${keyId}/${LOCALE}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
  });

  it('deletes the key (DELETE /:keyId)', async () => {
    const res = await app.request(`/api/translations/${keyId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
    keyId = '';
  });

  it('deletes the locale (DELETE /locales/:code)', async () => {
    const res = await app.request(`/api/translations/locales/${LOCALE}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
  });
});
