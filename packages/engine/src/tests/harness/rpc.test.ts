/**
 * Phase C — /api/rpc (routes/rpc.ts whitelist + function execution).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const FN = 'harness_rpc_ping';

d('rpc routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let whitelistId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await sql`
      CREATE OR REPLACE FUNCTION ${sql.raw(`"${FN}"`)}()
      RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'pong'::text $$
    `.execute(db);
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${FN}`
      .execute(db)
      .catch(() => {});
    const row = await sql<{ id: string }>`
      INSERT INTO zvd_rpc_functions (function_name, description, required_role, is_enabled)
      VALUES (${FN}, 'harness ping', 'member', true)
      ON CONFLICT (function_name) DO UPDATE SET is_enabled = true
      RETURNING id::text AS id
    `.execute(db);
    whitelistId = row.rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    await sql`
      DELETE FROM zvd_rpc_functions WHERE function_name IN (${FN}, 'harness_rpc_member_add')
    `
      .execute(db)
      .catch(() => {});
    await sql`DROP FUNCTION IF EXISTS ${sql.raw(`"${FN}"`)}()`.execute(db).catch(() => {});
  });

  it('POST /api/rpc/:fn executes a whitelisted SQL function', async () => {
    const res = await app.request(`/api/rpc/${FN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, string>> };
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('GET /api/rpc lists whitelisted functions for admins', async () => {
    const res = await app.request('/api/rpc', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { functions: Array<{ id: string; function_name: string }> };
    expect(body.functions.some((f) => f.function_name === FN)).toBe(true);
  });

  it('PATCH /api/rpc/:id toggles function metadata', async () => {
    const res = await app.request(`/api/rpc/${whitelistId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ description: 'updated harness fn' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { function: { description: string } };
    expect(body.function.description).toBe('updated harness fn');
  });

  it('a member cannot read or change the whitelist', async () => {
    // The whitelist decides which SQL functions anyone may execute. Each of its
    // four routes carries its own `requireInstanceAdmin`, and removing any one
    // of them left every other test here green: they all run as god.
    const { cookie: member } = await createMemberSession(app, db);
    const send = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', cookie: member },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    expect((await send('GET', '/api/rpc')).status).toBe(403);
    expect(
      (await send('POST', '/api/rpc', { function_name: 'harness_rpc_member_add' })).status,
    ).toBe(403);
    expect(
      (await send('PATCH', `/api/rpc/${whitelistId}`, { required_role: 'member' })).status,
    ).toBe(403);
    expect((await send('DELETE', `/api/rpc/${whitelistId}`)).status).toBe(403);

    const rows = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zvd_rpc_functions
       WHERE function_name IN (${FN}, 'harness_rpc_member_add')
    `.execute(db);
    expect(rows.rows[0]!.n).toBe(1);
  });

  it('rejects unauthenticated rpc calls', async () => {
    const res = await app.request(`/api/rpc/${FN}`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
