/**
 * ADR 0002 step 5: a rule names an object that exists.
 *
 * A `p` rule or a revoked default names `*`, an engine object (`admin`, `data`,
 * `$edge`), a registered extension's `$ext:<name>`, or an existing collection —
 * the database refuses anything else (migration 116). A collection's rules and
 * revoked defaults go with its drop, all of them. A schema plan refuses a grant
 * or a revoked default on a collection the instance will not have, before any
 * step runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, EDGE_SCOPE } from '../../lib/data/index.js';
import { serialize } from '../../lib/schema-artifact/export.js';
import { ENGINE_CASBIN_OBJECTS } from '../../lib/tenancy/permissions.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const tag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const ROLE = `rlo_role_${tag}`;
const COLL = `rlo_${tag}`;
const DROPPED = `rlo_drop_${tag}`;
const MISSING = `rlo_missing_${tag}`;
const EXT = `test/rlo-${tag}`;

d('rules live with their object', () => {
  let app: Hono;
  let db: Database;
  let god = '';

  const rule = (object: string, ptype = 'p') =>
    sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
        VALUES (${ptype}, ${ROLE}, '*', ${object}, 'read')`.execute(db);
  const revocation = (resource: string) =>
    sql`INSERT INTO zv_default_grant_revocations (role, resource, action)
        VALUES ('tenant_member', ${resource}, 'read')`.execute(db);
  const refused = async (write: Promise<unknown>) => {
    const err = await write.then(
      () => null,
      (e: { errno?: string }) => e,
    );
    expect(err?.errno).toBe('23503');
  };
  const call = (path: string, files: unknown) =>
    app.request(`/api/admin/schema/${path}`, {
      method: 'POST',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({ files }),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'title', type: 'text' }],
    } as never);
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${ROLE}`.execute(db);
    await sql`DELETE FROM zv_roles WHERE name = ${ROLE}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await dropTestCollection(db, COLL);
    await dropTestCollection(db, DROPPED);
  });

  it('the database refuses a rule or a revoked default on a missing object', async () => {
    await refused(rule(MISSING));
    await refused(revocation(MISSING));
    await refused(rule(`$ext:${EXT}`));
    // A retired zone slug or a v1 extension resource is no object either.
    await refused(rule('crm'));

    for (const object of ['*', ...ENGINE_CASBIN_OBJECTS, EDGE_SCOPE, COLL]) await rule(object);
    await revocation(COLL);
    // A role link names a domain, not an object.
    await rule(MISSING, 'g');

    // Moving a rule onto a missing object is a write like any other.
    await refused(
      sql`UPDATE zvd_permissions SET v2 = ${MISSING}
           WHERE ptype = 'p' AND v0 = ${ROLE} AND v2 = ${COLL}`.execute(db),
    );

    // The permissions API says so instead of failing.
    for (const method of ['POST', 'DELETE']) {
      const res = await app.request('/api/permissions/policies', {
        method,
        headers: { cookie: god, 'content-type': 'application/json' },
        body: JSON.stringify({ subject: 'tenant_member', resource: MISSING, action: 'read' }),
      });
      expect(`${method} ${res.status}`).toBe(`${method} 422`);
    }

    // A registered extension's own object, until its purge deletes the rules.
    await sql`INSERT INTO zv_extension_registry (name, display_name) VALUES (${EXT}, ${EXT})`.execute(
      db,
    );
    await rule(`$ext:${EXT}`);
  });

  it('dropping a collection deletes all its rules and revoked defaults', async () => {
    await DDLManager.createCollection(db, {
      name: DROPPED,
      fields: [{ name: 'title', type: 'text' }],
    } as never);
    await rule(DROPPED);
    await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
              VALUES ('p', ${ROLE}, 'tenant-x', ${DROPPED}, 'update')`.execute(db);
    await revocation(DROPPED);
    // Older than the collection, as an upgraded install's rules can be: the
    // drop guessed from the age which rules were the collection's, and kept these.
    await sql`UPDATE zvd_permissions SET created_at = now() - interval '1 day'
               WHERE ptype = 'p' AND v2 = ${DROPPED}`.execute(db);
    await sql`UPDATE zv_default_grant_revocations SET revoked_at = now() - interval '1 day'
               WHERE resource = ${DROPPED}`.execute(db);

    await DDLManager.dropCollection(db, DROPPED);

    const left = await sql<{ n: number }>`
      SELECT (SELECT count(*) FROM zvd_permissions WHERE ptype = 'p' AND v2 = ${DROPPED})
           + (SELECT count(*) FROM zv_default_grant_revocations WHERE resource = ${DROPPED})
             AS n`.execute(db);
    expect(Number(left.rows[0]?.n)).toBe(0);
  });

  it('a schema plan refuses a grant or a revoked default on a collection the instance will not have', async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${ROLE}`.execute(db);
    const files = (
      (await (
        await app.request('/api/admin/schema/export', { headers: { cookie: god } })
      ).json()) as { files: Record<string, string> }
    ).files;
    const roles = JSON.parse(files['roles.json']!);
    roles.roles.push({
      name: ROLE,
      description: 'from files',
      permissions: [
        { resource: COLL, actions: ['read'] },
        { resource: MISSING, actions: ['read'] },
      ],
    });
    const desired = { ...files, 'roles.json': serialize(roles) };

    const plan = (await (await call('plan', desired)).json()) as {
      steps: { target: string; action: string; op?: unknown }[];
    };
    const mine = plan.steps.filter((s) => s.target === `role ${ROLE}`);
    expect(mine.find((s) => s.action.startsWith(`grant ${COLL} `))?.op).toBeDefined();
    expect(mine.find((s) => s.action.startsWith(`grant ${MISSING} `))?.op).toBeUndefined();

    const res = await call('apply', desired);
    expect(res.status).toBe(409);
    // Nothing ran: not even the role the files create.
    const created = await sql`SELECT 1 FROM zv_roles WHERE name = ${ROLE}`.execute(db);
    expect(created.rows).toHaveLength(0);

    const member = roles.roles.find((r: { name: string }) => r.name === 'tenant_member');
    roles.roles = roles.roles.filter((r: { name: string }) => r.name !== ROLE);
    member.revokedDefaults = [
      ...(member.revokedDefaults ?? []),
      { resource: MISSING, actions: ['read'] },
    ];
    expect((await call('apply', { ...files, 'roles.json': serialize(roles) })).status).toBe(409);
    const recorded = await sql`SELECT 1 FROM zv_default_grant_revocations
                                WHERE resource = ${MISSING}`.execute(db);
    expect(recorded.rows).toHaveLength(0);
  });
});
