/**
 * `?expand=` must apply the RELATED collection's row-level policies.
 *
 * Column permissions on the target were already applied, so the shape of the
 * answer looked careful — but the rows themselves were fetched with a bare
 * `SELECT * WHERE id = ANY(...)`, outside any policy. So `?expand=parent`
 * returned parent rows the caller's own RLS policy exists to withhold, and it
 * did so through a query parameter on a collection they DO have access to.
 * The classic confused deputy: the caller is not authorized, the handler is,
 * and the handler asked on their behalf.
 *
 * Driven with an ordinary member rather than the god session, because god is
 * exempt from RLS — a god test would pass whatever the code did. The member is
 * granted read on BOTH collections first, so a withheld expansion can only be
 * the row policy and not the permission check that now sits next to it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  getEnforcer,
  invalidateRlsCache,
  invalidateUserPermCache,
} from '../../lib/tenancy/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const PARENT = `hexprls_p_${STAMP}`;
const CHILD = `hexprls_c_${STAMP}`;
const MEMBER_EMAIL = `harness-expand-rls-${STAMP}@test.local`;

d('expand applies the target collection RLS (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let memberId = '';
  let parentId = '';
  let childId = '';
  let policyId = '';

  const textField = (name: string) =>
    ({ name, type: 'text', required: false, unique: false, indexed: false }) as never;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);

    await DDLManager.createCollection(db, {
      name: PARENT,
      fields: [textField('title'), textField('owner_email')],
    } as never);
    await DDLManager.createCollection(db, {
      name: CHILD,
      fields: [
        textField('title'),
        {
          name: 'parent',
          type: 'm2o',
          required: false,
          unique: false,
          indexed: false,
          options: { related_collection: PARENT, on_delete: 'SET NULL' },
        },
      ],
    } as never);

    const create = async (collection: string, body: unknown) =>
      (
        (await (
          await app.request(`/api/data/${collection}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: godCookie },
            body: JSON.stringify(body),
          })
        ).json()) as { id: string }
      ).id;

    // Owned by somebody else, so the policy below excludes it for our member.
    parentId = await create(PARENT, { title: 'p', owner_email: 'someone-else@example.test' });
    childId = await create(CHILD, { title: 'c', parent: parentId });

    const password = 'MemberUser123!';
    const signUp = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: MEMBER_EMAIL, password, name: 'Member' }),
    });
    memberId = ((await signUp.json()) as { user?: { id: string } }).user?.id ?? '';
    await sql`UPDATE "user" SET role = 'member' WHERE id = ${memberId}`.execute(db);

    const enforcer = await getEnforcer();
    await enforcer.addPolicy(memberId, '*', CHILD, 'read');
    await enforcer.addPolicy(memberId, '*', PARENT, 'read');
    await invalidateUserPermCache(memberId);

    const signIn = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: MEMBER_EMAIL, password }),
    });
    memberCookie = (signIn.headers.get('set-cookie') ?? '')
      .split(',')
      .map((c) => c.split(';')[0]!.trim())
      .filter(Boolean)
      .join('; ');
  });

  afterAll(async () => {
    if (!db) return;
    if (policyId) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${policyId}::uuid`
        .execute(db)
        .catch(() => {});
      await invalidateRlsCache(PARENT).catch(() => {});
    }
    if (memberId) {
      await sql`DELETE FROM "session" WHERE "userId" = ${memberId}`.execute(db).catch(() => {});
      await sql`DELETE FROM "account" WHERE "userId" = ${memberId}`.execute(db).catch(() => {});
      await sql`DELETE FROM "user" WHERE id = ${memberId}`.execute(db).catch(() => {});
    }
    for (const name of [CHILD, PARENT]) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${name}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', name)
        .execute()
        .catch(() => {});
    }
  });

  it('expands the related row while no policy restricts it', async () => {
    // The control: with read on both collections and no policy, the relation
    // hydrates — so a failure below is the policy and not the plumbing.
    const res = await app.request(`/api/data/${CHILD}/${childId}?expand=parent`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.parent_expanded as Record<string, unknown>)?.id).toBe(parentId);
  });

  it('withholds a related row the policy excludes', async () => {
    const row = await sql<{ id: string }>`
      INSERT INTO zvd_rls_policies
        (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${PARENT}, '*', 'owner_email', 'eq', 'user_email', TRUE)
      RETURNING id
    `.execute(db);
    policyId = row.rows[0]!.id;
    await invalidateRlsCache(PARENT);

    const res = await app.request(`/api/data/${CHILD}/${childId}?expand=parent`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The reference itself is not a secret — `parent` keeps its id — but the
    // caller does not get the row's contents through the expansion.
    expect(body.parent).toBe(parentId);
    expect(body.parent_expanded).toBeUndefined();
  });
});
