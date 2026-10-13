/**
 * Creating a collection under a name existing Casbin rules already name is
 * refused (409, the rules listed) unless the caller adopts them (A13).
 *
 * The policy's object column is shared: a grant written before the collection
 * existed — or one a drop kept because it predates the dropped collection
 * (#1066) — took effect on a new collection of that name the moment it was
 * created, with nobody told. Owner decision 2026-10-13: refuse, list the rules,
 * create only on an explicit `adopt_rules: true`; never delete them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = Date.now();
const ROLE = `hrules_role_${SFX}`;
const FIELDS = [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }];
const made: string[] = [];
const name = (tag: string) => {
  const n = `hrules_${tag}_${SFX}`;
  made.push(n);
  return n;
};

type Listed = { ptype: string; subject: string; domain: string; object: string; action: string };

d('collection create over existing Casbin rules', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    const e = await getEnforcer();
    await e.removeFilteredPolicy(0, ROLE);
    for (const n of made) {
      await e.removeFilteredPolicy(2, n);
      await dropTestCollection(db, n);
    }
    await sql`DELETE FROM zv_schema_branches WHERE name LIKE ${`hrules-%`}`.execute(db);
  });

  it('a leftover rule refuses POST /api/collections with 409 and lists it', async () => {
    const coll = name('route');
    await (await getEnforcer()).addPolicy(ROLE, '*', coll, 'read');

    const res = await post('/api/collections', { name: coll, fields: FIELDS });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; errors: Listed[] };
    expect(body.code).toBe('existing_rules');
    expect(body.errors).toEqual([
      { ptype: 'p', subject: ROLE, domain: '*', object: coll, action: 'read' },
    ]);
    // Nothing written, and the rules are left as they were.
    expect(await DDLManager.getCollection(db, coll)).toBeNull();
    expect(await DDLManager.tableExists(db, coll)).toBe(false);
    expect(await (await getEnforcer()).hasPolicy(ROLE, '*', coll, 'read')).toBe(true);
  });

  it('adopt_rules: true creates it, and the adopted rule takes effect', async () => {
    const coll = name('adopt');
    const member = await createMemberSession(app, db);
    await (await getEnforcer()).addPolicy(member.userId, '*', coll, 'read');
    await invalidateUserPermCache(member.userId);

    const res = await post('/api/collections', { name: coll, fields: FIELDS, adopt_rules: true });
    expect(res.status, await res.clone().text()).toBe(202);
    expect(await DDLManager.tableExists(db, coll)).toBe(true);

    const read = await app.request(`/api/data/${coll}`, { headers: { cookie: member.cookie } });
    expect(read.status, await read.clone().text()).toBe(200);
  }, 60_000);

  it('with no rule naming it, a create is unchanged', async () => {
    const coll = name('clean');
    const res = await post('/api/collections', { name: coll, fields: FIELDS });
    expect(res.status, await res.clone().text()).toBe(202);
    expect(await DDLManager.tableExists(db, coll)).toBe(true);
  }, 60_000);

  it("'*' rules and the dead data:<name> form do not count", async () => {
    const coll = name('star');
    const e = await getEnforcer();
    await e.addPolicy(ROLE, '*', '*', '*');
    await e.addPolicy(ROLE, '*', '*', 'read');
    await e.addPolicy(ROLE, '*', `data:${coll}`, 'read');
    const res = await post('/api/collections', { name: coll, fields: FIELDS });
    expect(res.status, await res.clone().text()).toBe(202);
  }, 60_000);

  it('DDLManager.createCollection refuses too — the extension and job path', async () => {
    const coll = name('direct');
    await (await getEnforcer()).addPolicy(ROLE, 'some-tenant', coll, 'delete');
    await expect(
      DDLManager.createCollection(db, { name: coll, fields: FIELDS } as never),
    ).rejects.toThrow(/adopt_rules/);
    expect(await DDLManager.tableExists(db, coll)).toBe(false);
    await DDLManager.createCollection(db, {
      name: coll,
      fields: FIELDS,
      adoptRules: true,
    } as never);
    expect(await DDLManager.tableExists(db, coll)).toBe(true);
  }, 60_000);

  it('a template install is refused before it writes anything', async () => {
    const pfx = `hrtpl${SFX}`;
    const tickets = `${pfx}_hd_tickets`;
    made.push(tickets);
    await (await getEnforcer()).addPolicy(ROLE, '*', tickets, 'update');
    const res = await post('/api/templates/helpdesk/install', { prefix: pfx });
    expect(res.status, await res.clone().text()).toBe(409);
    expect(((await res.json()) as { errors: Listed[] }).errors.map((r) => r.object)).toEqual([
      tickets,
    ]);
    const rows = await sql`SELECT 1 FROM zvd_collections WHERE name LIKE ${`${pfx}_%`}`.execute(db);
    expect(rows.rows).toEqual([]);
  }, 60_000);

  it('a schema-branch merge is refused before it applies anything, and adopts on request', async () => {
    const coll = name('branch');
    await (await getEnforcer()).addPolicy(ROLE, '*', coll, 'read');
    const created = await post('/api/schema/branches', { name: `hrules-${SFX}` });
    expect(created.status).toBe(201);
    const { branch, schema } = (await created.json()) as { branch: { id: string }; schema: string };
    try {
      const change = await post(`/api/schema/branches/${branch.id}/changes`, {
        type: 'add_collection',
        payload: { name: coll, fields: FIELDS },
      });
      expect(change.status).toBeLessThan(300);

      const refused = await post(`/api/schema/branches/${branch.id}/merge`, {});
      expect(refused.status, await refused.clone().text()).toBe(409);
      expect(((await refused.json()) as { errors: Listed[] }).errors).toHaveLength(1);
      expect(await DDLManager.tableExists(db, coll)).toBe(false);

      const merged = await post(`/api/schema/branches/${branch.id}/merge`, { adopt_rules: true });
      expect(((await merged.json()) as { errors: string[] }).errors).toEqual([]);
      expect(await DDLManager.tableExists(db, coll)).toBe(true);
    } finally {
      await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);
    }
  }, 60_000);

  it('schema apply is refused before any change, and adopts on request', async () => {
    const coll = name('apply');
    await DDLManager.createCollection(db, { name: coll, fields: FIELDS } as never);
    const files = (
      (await (await app.request('/api/admin/schema/export', { headers: { cookie } })).json()) as {
        files: Record<string, string>;
      }
    ).files;
    await DDLManager.dropCollection(db, coll);
    await (await getEnforcer()).addPolicy(ROLE, '*', coll, 'read');

    const refused = await post('/api/admin/schema/apply', { files });
    expect(refused.status, await refused.clone().text()).toBe(409);
    expect(((await refused.json()) as { errors: Listed[] }).errors.map((r) => r.object)).toEqual([
      coll,
    ]);
    expect(await DDLManager.tableExists(db, coll)).toBe(false);

    const applied = await post('/api/admin/schema/apply', { files, adopt_rules: true });
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(await DDLManager.tableExists(db, coll)).toBe(true);
  }, 60_000);
});
