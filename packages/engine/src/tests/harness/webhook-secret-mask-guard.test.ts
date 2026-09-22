/**
 * A PATCH must not store the mask as the signing secret.
 *
 * `GET /api/webhooks` replaces the stored secret with `••••••••` — the engine
 * never returns the plaintext. The Studio's edit dialog put that masked value
 * into its form and sent it back, so saving a webhook after changing only its
 * URL re-signed every future delivery with eight bullet characters and every
 * receiver's HMAC check failed, silently.
 *
 * The Studio no longer sends it (see `webhooks-page.test.ts`); this is the
 * other half, because the route is what any client can reach. `routes/settings.ts`
 * has refused the mask since secrets were masked there — this route had no such
 * guard.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('PATCH /api/webhooks/:id — the masked secret', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let id: string;

  async function storedSecret(): Promise<string | null> {
    const r = await sql<{ secret: string | null }>`
      SELECT secret FROM zvd_webhooks WHERE id = ${id}
    `.execute(db);
    return r.rows[0]?.secret ?? null;
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const res = await app.request('/api/webhooks', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'mask-guard',
        url: 'https://example.com/hook',
        events: ['data.create'],
        secret: 'the-real-signing-secret',
      }),
    });
    expect(res.status).toBe(201);
    id = ((await res.json()) as { webhook: { id: string } }).webhook.id;
  });

  it('keeps the stored secret when the mask is sent back', async () => {
    const before = await storedSecret();
    expect(before).toBeTruthy();

    const res = await app.request(`/api/webhooks/${id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/moved', secret: '••••••••' }),
    });
    expect(res.status).toBe(200);

    // The URL changed; the secret did not.
    const body = (await res.json()) as { webhook: { url: string } };
    expect(body.webhook.url).toBe('https://example.com/moved');
    expect(await storedSecret()).toBe(before);
  });

  it('still rotates the secret when a real one is sent', async () => {
    const before = await storedSecret();
    const res = await app.request(`/api/webhooks/${id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'a-rotated-secret' }),
    });
    expect(res.status).toBe(200);
    const after = await storedSecret();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    // Stored encrypted, so the plaintext must not be sitting in the column.
    expect(after).not.toBe('a-rotated-secret');
  });
});
