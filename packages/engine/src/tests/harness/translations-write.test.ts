/**
 * Phase C — /api/translations write paths (routes/translations.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const LOCALE = `h${Date.now().toString(36).slice(-6)}`;
const KEY = `harness.key.${Date.now()}`;

d('translations write routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let keyId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    if (keyId) {
      await db
        .deleteFrom('zvd_translations')
        .where('key_id', '=', keyId)
        .execute()
        .catch(() => {});
      await db
        .deleteFrom('zvd_translation_keys')
        .where('id', '=', keyId)
        .execute()
        .catch(() => {});
    }
    await db
      .deleteFrom('zvd_locales')
      .where('code', '=', LOCALE)
      .execute()
      .catch(() => {});
  });

  it('POST /api/translations/locales adds a locale', async () => {
    const res = await app.request('/api/translations/locales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ code: LOCALE, name: 'Harness Locale', is_default: false }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { locale: { code: string } };
    expect(body.locale.code).toBe(LOCALE);
  });

  it('POST /api/translations creates a translation key', async () => {
    const res = await app.request('/api/translations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        key: KEY,
        context: 'harness',
        default_value: 'Hello',
        tags: ['test'],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: { id: string; key: string } };
    keyId = body.key.id;
    expect(body.key.key).toBe(KEY);
  });

  it('PUT /api/translations/:keyId/:locale upserts a translation value', async () => {
    const res = await app.request(`/api/translations/${keyId}/${LOCALE}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ value: 'Salut', reviewed: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { translation: { value: string } };
    expect(body.translation.value).toBe('Salut');
  });

  it('GET /api/translations/public/:locale includes the new translation', async () => {
    const res = await app.request(`/api/translations/public/${LOCALE}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { translations: Record<string, string> };
    expect(body.translations[KEY]).toBe('Salut');
  });
});
