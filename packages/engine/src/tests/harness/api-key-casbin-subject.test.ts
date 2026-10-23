/**
 * An API key is not a Casbin subject.
 *
 * A key's grant is its scopes AND its issuer's permission (`checkAccess`,
 * `keyIssuerAllows`); Casbin holds no policy for `apikey:<uuid>`. Probe: a key
 * scoped to CHILD only, issued by a member who reads CHILD and PARENT, with
 * `apikey:<uuid>` then named in Casbin rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import {
  checkPermission,
  getEnforcer,
  getUserRoles,
  grantMemberRole,
  invalidateUserPermCache,
  isTenantAdmin,
} from '../../lib/tenancy/permissions.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const PARENT = `hkeysubj_p_${STAMP}`;
const CHILD = `hkeysubj_c_${STAMP}`;
const ISSUER_ROLE = `keysubj_issuer_${STAMP}`;
const KEY_ROLE = `keysubj_key_${STAMP}`;

const text = (name: string) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
});

d('an API key is not a Casbin subject', () => {
  let app: Awaited<ReturnType<typeof getTestApp>>['app'];
  let db: Database;
  let cookie = '';
  let issuer = '';
  let keyId = '';
  let raw = '';
  let childId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, { name: PARENT, fields: [text('title')] } as never);
    await DDLManager.createCollection(db, {
      name: CHILD,
      fields: [
        text('title'),
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
    const parentId = (
      await sql<{ id: string }>`
        INSERT INTO ${sql.table(`zvd_${PARENT}`)} (tenant_id, title)
        VALUES (${DEFAULT_TENANT_ID}::uuid, 'secret parent') RETURNING id`.execute(db)
    ).rows[0]!.id;
    childId = (
      await sql<{ id: string }>`
        INSERT INTO ${sql.table(`zvd_${CHILD}`)} (tenant_id, title, parent)
        VALUES (${DEFAULT_TENANT_ID}::uuid, 'c', ${parentId}::uuid) RETURNING id`.execute(db)
    ).rows[0]!.id;

    issuer = `harness-keysubj-${crypto.randomUUID()}`;
    await sql`INSERT INTO "user" (id, name, email)
              VALUES (${issuer}, 'Harness issuer', ${`${issuer}@test.local`})`.execute(db);
    const e = await getEnforcer();
    await e.addPolicy(ISSUER_ROLE, '*', CHILD, 'read');
    await e.addPolicy(ISSUER_ROLE, '*', PARENT, 'read');
    await e.addPolicy(KEY_ROLE, '*', PARENT, 'read');
    await e.addRoleForUser(issuer, ISSUER_ROLE, '*');
    await grantMemberRole(issuer);
    await invalidateUserPermCache(issuer);

    raw = generateApiKey();
    keyId = (
      await sql<{ id: string }>`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, rate_limit, is_active, tenant_id, created_by)
        VALUES ('casbin subject probe', ${await hashApiKey(raw)}, 'zvk_', ${JSON.stringify([{ collection: CHILD, actions: ['read'] }])}::jsonb, 100, true,
                ${DEFAULT_TENANT_ID}::uuid, ${issuer})
        RETURNING id`.execute(db)
    ).rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    const e = await getEnforcer();
    await e.removeFilteredPolicy(0, ISSUER_ROLE).catch(() => {});
    await e.removeFilteredPolicy(0, KEY_ROLE).catch(() => {});
    await e.deleteRolesForUser(issuer).catch(() => {});
    await e.deleteRolesForUser(`apikey:${keyId}`).catch(() => {});
    await sql`DELETE FROM zv_api_keys WHERE id = ${keyId}::uuid`.execute(db).catch(() => {});
    await sql`DELETE FROM "user" WHERE id = ${issuer}`.execute(db).catch(() => {});
    await dropTestCollection(db, CHILD).catch(() => {});
    await dropTestCollection(db, PARENT).catch(() => {});
  });

  const expanded = async (key = raw) => {
    const res = await app.request(`/api/data/${CHILD}/${childId}?expand=parent`, {
      headers: { 'X-API-Key': key },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as Record<string, unknown>).parent_expanded;
  };

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  /** What Casbin answers for the key — what `ctx.internals.isTenantAdmin`,
   * `ctx.getUserRoles` and every bare `checkPermission` hand an extension. */
  const casbinSays = async () => ({
    admin: await isTenantAdmin(`apikey:${keyId}`),
    read: await checkPermission(`apikey:${keyId}`, PARENT, 'read'),
    roles: await getUserRoles(`apikey:${keyId}`),
  });
  const NOTHING = { admin: false, read: false, roles: [] };

  it('POST /api/permissions/roles refuses an API-key subject', async () => {
    const res = await post('/api/permissions/roles', { userId: `apikey:${keyId}`, role: 'admin' });
    expect(res.status).toBe(422);
    expect(await casbinSays()).toEqual(NOTHING);
  });

  it('POST /api/permissions/policies refuses an API-key subject', async () => {
    const res = await post('/api/permissions/policies', {
      subject: `apikey:${keyId}`,
      resource: PARENT,
      action: 'read',
    });
    expect(res.status).toBe(422);
    expect(await casbinSays()).toEqual(NOTHING);
  });

  it('POST /api/admin/roles/hierarchy refuses an API-key child', async () => {
    const res = await post('/api/admin/roles/hierarchy', {
      child: `apikey:${keyId}`,
      parent: KEY_ROLE,
    });
    expect(res.status).toBe(422);
    expect(await casbinSays()).toEqual(NOTHING);
  });

  it('a Casbin row naming the key anyway grants it nothing', async () => {
    const e = await getEnforcer();
    await e.addRoleForUser(`apikey:${keyId}`, 'admin', '*');
    await e.addRoleForUser(`apikey:${keyId}`, KEY_ROLE, '*');
    await e.addPolicy(`apikey:${keyId}`, '*', PARENT, 'read');
    await invalidateUserPermCache(`apikey:${keyId}`);
    try {
      expect(await casbinSays()).toEqual(NOTHING);
      expect(await expanded()).toBeUndefined();
    } finally {
      await e.deleteRolesForUser(`apikey:${keyId}`);
      await e.removeFilteredPolicy(0, `apikey:${keyId}`);
      await invalidateUserPermCache(`apikey:${keyId}`);
    }
  });

  it('a key scoped to the related collection expands it, as its issuer may', async () => {
    const both = generateApiKey();
    const id = (
      await sql<{ id: string }>`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, rate_limit, is_active, tenant_id, created_by)
        VALUES ('casbin subject probe 2', ${await hashApiKey(both)}, 'zvk_', ${JSON.stringify([
          { collection: CHILD, actions: ['read'] },
          { collection: PARENT, actions: ['read'] },
        ])}::jsonb, 100, true,
                ${DEFAULT_TENANT_ID}::uuid, ${issuer})
        RETURNING id`.execute(db)
    ).rows[0]!.id;
    try {
      expect(await expanded()).toBeUndefined();
      expect((await expanded(both)) as { title?: string }).toMatchObject({
        title: 'secret parent',
      });
    } finally {
      await sql`DELETE FROM zv_api_keys WHERE id = ${id}::uuid`.execute(db);
    }
  });
});
