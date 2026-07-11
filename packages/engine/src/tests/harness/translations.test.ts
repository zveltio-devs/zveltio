/**
 * Phase C — /api/translations (routes/translations.ts public + admin locale paths).
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('translations routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  it('GET /api/translations/public/:locale returns a translation map', async () => {
    const res = await app.request('/api/translations/public/en');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locale: string; translations: Record<string, string> };
    expect(body.locale).toBe('en');
    expect(typeof body.translations).toBe('object');
  });

  it('GET /api/translations/locales lists locales for admins', async () => {
    const res = await app.request('/api/translations/locales', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locales?: unknown[] };
    expect(Array.isArray(body.locales)).toBe(true);
  });

  it('GET /api/translations lists translation keys for admins', async () => {
    const res = await app.request('/api/translations', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys?: unknown[] };
    expect(Array.isArray(body.keys)).toBe(true);
  });

  it('GET /api/translations/glossary returns glossary rows', async () => {
    const res = await app.request('/api/translations/glossary', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { glossary?: unknown[] };
    expect(Array.isArray(body.glossary)).toBe(true);
  });

  it('rejects unauthenticated admin locale access', async () => {
    const res = await app.request('/api/translations/locales');
    expect([401, 403]).toContain(res.status);
  });
});
