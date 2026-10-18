/**
 * A key never sees or writes a column its issuer cannot.
 *
 * Column rules match one role. A key's role is `api_key`, so a rule written for
 * `member` never reached a member's key: the key read the column hidden from
 * its issuer and wrote the one the issuer may only read. A key now answers to
 * both — its own rules (`api_key`, `*`) and its issuer's — the stricter winning.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const C = `akcol_${Date.now()}`;
const ROOT = '00000000-0000-0000-0000-000000000001';
type Row = Record<string, unknown>;

d('an API key is held to its issuer’s column rules', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let recordId = '';
  const keys: Record<'member' | 'god', string> = { member: '', god: '' };

  const mint = async (createdBy: string) => {
    const raw = generateApiKey();
    await sql`
      INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, created_by, tenant_id)
      VALUES (${`akcol-${raw.slice(4, 12)}`}, ${await hashApiKey(raw)}, ${raw.slice(0, 12)},
              ${JSON.stringify([{ collection: C, actions: ['read', 'create', 'update'] }])}::jsonb,
              true, ${createdBy}, ${ROOT}::uuid)`.execute(db);
    return raw;
  };
  const asKey = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/data/${C}${path}`, {
      method,
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Row & { data?: Row } };
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    const godId = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]!.id;
    const issuer = await createMemberSession(app, db, {
      grants: [{ collection: C, actions: ['read', 'create', 'update'] }],
    });
    await DDLManager.createCollection(db, {
      name: C,
      adoptRules: true,
      fields: ['title', 'salary', 'locked', 'keynote'].map((name) => ({
        name,
        type: 'text',
        required: false,
        unique: false,
        indexed: false,
      })),
    } as never);
    await db
      .insertInto('zvd_column_permissions')
      .values([
        // The issuer's role: `salary` unseen, `locked` read-only.
        {
          collection_name: C,
          column_name: 'salary',
          role: 'member',
          can_read: false,
          can_write: false,
        },
        {
          collection_name: C,
          column_name: 'locked',
          role: 'member',
          can_read: true,
          can_write: false,
        },
        // The key's own role.
        {
          collection_name: C,
          column_name: 'keynote',
          role: 'api_key',
          can_read: false,
          can_write: false,
        },
      ])
      .execute();
    await invalidateColumnPermCache(C);
    keys.member = await mint(issuer.userId);
    keys.god = await mint(godId);
    const res = await app.request(`/api/data/${C}`, {
      method: 'POST',
      headers: { cookie: god, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', salary: '100', locked: 'l', keynote: 'k' }),
    });
    expect(res.status).toBe(201);
    recordId = ((await res.json()) as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name LIKE 'akcol-%'`.execute(db);
    await db.deleteFrom('zvd_column_permissions').where('collection_name', '=', C).execute();
    await invalidateColumnPermCache(C);
    await dropTestCollection(db, C);
  });

  it('hides from a member’s key what is hidden from the member', async () => {
    const one = await asKey(keys.member, 'GET', `/${recordId}`);
    expect(one.status).toBe(200);
    const row = (one.body.data ?? one.body) as Row;
    expect(row.title).toBe('t');
    expect('salary' in row).toBe(false);
    expect('keynote' in row).toBe(false);
  });

  it('refuses a member’s key a write the member may not make', async () => {
    expect((await asKey(keys.member, 'PATCH', `/${recordId}`, { locked: 'x' })).status).toBe(403);
    expect((await asKey(keys.member, 'PATCH', `/${recordId}`, { title: 'ok' })).status).toBe(200);
  });

  it('gives a god’s key the issuer half’s exemption, not the key’s own rules', async () => {
    const one = await asKey(keys.god, 'GET', `/${recordId}`);
    const row = (one.body.data ?? one.body) as Row;
    expect(row.salary).toBe('100');
    expect('keynote' in row).toBe(false);
  });
});
