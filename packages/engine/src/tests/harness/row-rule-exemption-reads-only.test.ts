/**
 * The row-rule exemption covers reads only (ADR 0037).
 *
 * `data:view_all` — a god holds it — and an API key's `rls_bypass` under it let
 * the caller read every row whatever the row rules say. They used to let it
 * WRITE every row too: the generated policy put the exemption in `WITH CHECK`,
 * and `getRlsFilters` returned no filter for a write's before-row. So a god
 * approved their own order under ADR 0016's four-eyes rule (LV-02), and edited
 * or deleted any user's row under `* created_by eq user_id`.
 *
 * A write now meets the rules that apply to the caller, and a refused one is a
 * 403 `row_level_security_violation`, not "Record not found" and not a success.
 * A rule binds the roles it names, nothing more (decision 5).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import {
  DEFAULT_TENANT_ID,
  getEnforcer,
  invalidateUserPermCache,
} from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
/** `* created_by eq user_id`: everyone sees and writes only their own rows. */
const OWN = `hexown_${STAMP}`;
/** ADR 0016's decision collection: `* order_author neq user_id`. */
const DECIDE = `hexdecide_${STAMP}`;
/** `member created_by eq user_id`: binds the holders of `member` alone. */
const SCOPED = `hexscoped_${STAMP}`;
const CRUD = ['read', 'create', 'update', 'delete'];

/** A write the rules refuse, said as such (decision 4), as the problem body carries it. */
const REFUSED = { status: 403, detail: 'row_level_security_violation', code: '42501' };

d('the row-rule exemption covers reads only (ADR 0037)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let godId = '';
  let alice = '';
  let bob = '';
  let key = '';
  let aliceRow = '';
  let godRow = '';

  /** `auth` is a session cookie, or the bypass key itself. */
  const call = (method: string, path: string, auth: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth === key ? { 'X-API-Key': key } : { cookie: auth }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const create = async (coll: string, auth: string, body: Record<string, unknown>) => {
    const res = await call('POST', `/api/data/${coll}`, auth, body);
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  /** A row as the database holds it, read past every rule. */
  const stored = async (coll: string, id: string) =>
    (
      await db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('zveltio.rls_bypass', 'on', true)`.execute(trx);
        return sql<{ title: string }>`
          SELECT title FROM ${sql.id(`zvd_${coll}`)} WHERE id = ${id}`.execute(trx);
      })
    ).rows[0]?.title;

  const rule = async (collection: string, role: string, field: string, op: string) => {
    const res = await call('POST', '/api/admin/rls', god, {
      collection,
      role,
      filter_field: field,
      filter_op: op,
      filter_value_source: 'user_id',
    });
    expect(res.status).toBe(201);
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db, { runAsRole: false });
    godId = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]!.id;

    const text = (name: string) => ({
      name,
      type: 'text',
      required: false,
      unique: false,
      indexed: false,
    });
    for (const [name, fields] of [
      [OWN, [text('title')]],
      [DECIDE, [text('title'), text('order_author')]],
      [SCOPED, [text('title')]],
    ] as const) {
      await DDLManager.createCollection(db, { name, fields } as never);
    }
    // After the collections: a grant names an object that exists (migration 116).
    const grants = [OWN, DECIDE, SCOPED].map((collection) => ({ collection, actions: CRUD }));
    alice = (await createMemberSession(app, db, { grants })).cookie;
    bob = (await createMemberSession(app, db, { grants })).cookie;
    await rule(OWN, '*', 'created_by', 'eq');
    await rule(DECIDE, '*', 'order_author', 'neq');
    await rule(SCOPED, 'member', 'created_by', 'eq');

    // A key with `rls_bypass`, issued by the god: a row rule resolves it to them.
    key = generateApiKey();
    await sql`
      INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, rls_bypass, tenant_id, created_by)
      VALUES (${`hex-${STAMP}`}, ${await hashApiKey(key)}, ${key.slice(0, 12)},
              ${JSON.stringify([OWN, DECIDE].map((collection) => ({ collection, actions: ['*'] })))}::jsonb,
              true, true, ${DEFAULT_TENANT_ID}::uuid, ${godId})`.execute(db);

    aliceRow = await create(OWN, alice, { title: 'alice' });
    godRow = await create(OWN, god, { title: 'god' });
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name = ${`hex-${STAMP}`}`.execute(db).catch(() => {});
    if (godId) {
      await (await getEnforcer()).addRoleForUser(godId, 'member', '*').catch(() => {});
      await invalidateUserPermCache(godId);
    }
    for (const c of [OWN, DECIDE, SCOPED]) {
      await sql`DELETE FROM zvd_rls_policies WHERE collection = ${c}`.execute(db).catch(() => {});
      await dropTestCollection(db, c).catch(() => {});
    }
  });

  describe('a data:view_all holder under `* created_by eq user_id`', () => {
    it('reads every row', async () => {
      const res = await call('GET', `/api/data/${OWN}?limit=50`, god);
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as { records: { id: string }[] }).records.map((r) => r.id);
      expect(ids.sort()).toEqual([aliceRow, godRow].sort());
    });

    it("is refused on PATCH and PUT of another user's row, which stays as it was", async () => {
      for (const method of ['PATCH', 'PUT']) {
        const res = await call(method, `/api/data/${OWN}/${aliceRow}`, god, { title: 'GOD' });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject(REFUSED);
      }
      expect(await stored(OWN, aliceRow)).toBe('alice');
    });

    it("is refused on DELETE of another user's row, which stays", async () => {
      const res = await call('DELETE', `/api/data/${OWN}/${aliceRow}`, god);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject(REFUSED);
      expect(await stored(OWN, aliceRow)).toBe('alice');
    });

    it('is refused per row on bulk PATCH and bulk DELETE', async () => {
      const patch = await call('PATCH', `/api/data/${OWN}/bulk`, god, {
        records: [{ id: aliceRow, title: 'GOD' }],
      });
      expect(patch.status).toBe(207);
      expect(((await patch.json()) as { errors: unknown[] }).errors).toEqual([
        { index: 0, id: aliceRow, errors: ['row_level_security_violation'] },
      ]);
      const del = await call('DELETE', `/api/data/${OWN}/bulk`, god, { ids: [aliceRow] });
      expect(del.status).toBe(207);
      expect(((await del.json()) as { forbidden?: string[] }).forbidden).toEqual([aliceRow]);
      expect(await stored(OWN, aliceRow)).toBe('alice');
    });

    it('still writes its own row', async () => {
      const res = await call('PATCH', `/api/data/${OWN}/${godRow}`, god, { title: 'god-2' });
      expect(res.status).toBe(200);
      expect(await stored(OWN, godRow)).toBe('god-2');
    });
  });

  describe('LV-02: a decision collection under `* order_author neq user_id`', () => {
    it('refuses the god deciding their own order, on insert and bulk insert', async () => {
      const res = await call('POST', `/api/data/${DECIDE}`, god, {
        title: 'approve',
        order_author: godId,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject(REFUSED);
      const bulk = await call('POST', `/api/data/${DECIDE}/bulk`, god, {
        records: [{ title: 'approve', order_author: godId }],
      });
      expect(bulk.status).toBe(403);
    });

    it('lets another user decide it', async () => {
      await create(DECIDE, bob, { title: 'approve', order_author: godId });
    });
  });

  describe("a bypass key, whose issuer holds data:view_all, is the god's", () => {
    it('reads every row', async () => {
      const res = await call('GET', `/api/data/${OWN}?limit=50`, key);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { records: unknown[] }).records.length).toBe(2);
    });

    it('is refused on insert, update and delete past the rules', async () => {
      const insert = await call('POST', `/api/data/${DECIDE}`, key, {
        title: 'approve',
        order_author: godId,
      });
      expect(insert.status).toBe(403);
      for (const [method, body] of [
        ['PATCH', { title: 'KEY' }],
        ['DELETE', undefined],
      ] as const) {
        const res = await call(method, `/api/data/${OWN}/${aliceRow}`, key, body);
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject(REFUSED);
      }
      expect(await stored(OWN, aliceRow)).toBe('alice');
    });
  });

  describe('a rule binds the roles it names (decision 5)', () => {
    it('binds a god who holds `member`, and not an administrator without it', async () => {
      const bobRow = await create(SCOPED, bob, { title: 'bob' });
      // Every account holds `member` (migration 059), the god included.
      const held = await call('PATCH', `/api/data/${SCOPED}/${bobRow}`, god, { title: 'GOD' });
      expect(held.status).toBe(403);
      await (await getEnforcer()).deleteRoleForUser(godId, 'member', '*');
      await invalidateUserPermCache(godId);
      const res = await call('PATCH', `/api/data/${SCOPED}/${bobRow}`, god, { title: 'GOD' });
      expect(res.status).toBe(200);
      expect(await stored(SCOPED, bobRow)).toBe('GOD');
    });
  });
});
