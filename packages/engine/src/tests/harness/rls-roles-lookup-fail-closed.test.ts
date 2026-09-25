/**
 * A role lookup that FAILS must not publish "no roles" to the database policy.
 *
 * The tenant middleware builds the identity the generated RESTRICTIVE row-rule
 * policy reads (`zveltio.user_roles`). A rule keyed on a role applies only when
 * that role is in the list, so the middleware's `getUserRoles(...).catch(() =>
 * [])` turned a failed lookup into "this caller holds no role" and the database
 * stood every role-keyed rule down.
 *
 * `/api/data` also filters in the engine, so it needed both enforcers to fail.
 * `POST /api/saved-queries/execute` reads the live table through the tenant
 * transaction with no engine row filter at all — the database policy is the
 * only thing between the caller and the rows its rules hide. That is the door
 * this drives.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { applyTenantRLS, getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/index.js';
import { invalidateRlsCache } from '../../lib/tenancy/rls.js';
import { applyRowRulePolicy } from '../../lib/tenancy/row-rule-policy.js';
import {
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `rlsroles_${Date.now()}`;
const ROLE = `field_agent_${Date.now()}`;

d('a failed role lookup does not stand role-keyed row rules down', () => {
  let app: Hono;
  let db: Database;
  let member: { cookie: string; userId: string; email: string };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'owner_ref', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    // What the DDL queue does for a collection created through the product.
    await applyTenantRLS(db, `zvd_${COLLECTION}`);
    member = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read', 'list'] }],
    });
    // A Casbin role — what POST /api/users/:id/roles assigns — not the
    // `"user".role` column, which the middleware appends on its own.
    await (await getEnforcer()).addGroupingPolicy(member.userId, ROLE, '*');
    await invalidateUserPermCache(member.userId);
    await sql`
      INSERT INTO ${sql.table(`zvd_${COLLECTION}`)} (title, owner_ref)
      VALUES ('mine', ${member.userId}), ('theirs', 'someone-else')
    `.execute(db);
    await sql`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${COLLECTION}, ${ROLE}, 'owner_ref', 'eq', 'user_id', TRUE)
    `.execute(db);
    await invalidateRlsCache(COLLECTION);
    // The route's rebuild is deferred past the commit; run it here and wait.
    await applyRowRulePolicy(db, COLLECTION);
  });

  afterAll(async () => {
    if (!db) return;
    await (await getEnforcer()).removeGroupingPolicy(member.userId, ROLE, '*').catch(() => {});
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  const execute = () =>
    app.request('/api/saved-queries/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: member.cookie },
      body: JSON.stringify({ collection: COLLECTION, config: { limit: 50 } }),
    });

  it('the rule holds when the roles resolve (the behaviour being kept)', async () => {
    const res = await execute();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"mine"');
    expect(body).not.toContain('"theirs"');
  });

  it('a rejected role lookup refuses the request instead of serving hidden rows', async () => {
    const enforcer = await getEnforcer();
    const spy = spyOn(enforcer, 'getRolesForUser').mockRejectedValue(
      new Error('role manager unavailable'),
    );
    try {
      await invalidateUserPermCache(member.userId);
      const res = await execute();
      expect(await res.text()).not.toContain('"theirs"');
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
      await invalidateUserPermCache(member.userId);
    }
  });
});
