/**
 * Phase C — 404 when collection metadata is missing (handlers/list, single, bulk).
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const MISSING = `h404_${Date.now()}_nope`;

d('data collection not found (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  it('returns 404 on list GET for an unknown collection', async () => {
    const res = await app.request(`/api/data/${MISSING}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('returns 404 on single GET for an unknown collection', async () => {
    const res = await app.request(`/api/data/${MISSING}/00000000-0000-4000-8000-000000000001`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 on bulk POST for an unknown collection', async () => {
    const res = await app.request(`/api/data/${MISSING}/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ records: [{ title: 'x' }] }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 on bulk PATCH for an unknown collection', async () => {
    const res = await app.request(`/api/data/${MISSING}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [{ id: '00000000-0000-4000-8000-000000000001', title: 'x' }],
      }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 on bulk DELETE for an unknown collection', async () => {
    const res = await app.request(`/api/data/${MISSING}/bulk`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ ids: ['00000000-0000-4000-8000-000000000001'] }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 on single POST for an unknown collection', async () => {
    const res = await app.request(`/api/data/${MISSING}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 on single PATCH for an unknown collection', async () => {
    const res = await app.request(`/api/data/${MISSING}/00000000-0000-4000-8000-000000000002`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 on single PUT for an unknown collection', async () => {
    const res = await app.request(`/api/data/${MISSING}/00000000-0000-4000-8000-000000000003`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 on single DELETE for an unknown collection', async () => {
    const res = await app.request(`/api/data/${MISSING}/00000000-0000-4000-8000-000000000004`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});
