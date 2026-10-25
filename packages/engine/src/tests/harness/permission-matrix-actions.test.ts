/**
 * The permissions screen granted actions the engine never asks for.
 *
 * `GET /api/admin/resources` offered each collection `view, create, update,
 * delete`; the screen writes whatever it is offered through
 * `POST /api/admin/permissions/bulk`. The data handlers ask Casbin for `read`,
 * and the matcher compares actions exactly — so ticking "view" for a role
 * granted nothing, and every member of that role was refused 403 on a
 * collection the screen showed as readable.
 *
 * The suite drives the same three calls the screen and the role assignment
 * make, then reads the collection as a member of that role.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { recordManifest } from '../../lib/tenancy/resource-grants.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `permmatrix_${Date.now()}`;
const ROLE = `permmatrix_role_${Date.now()}`;

d('permission matrix actions match what the engine checks', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  let member: { cookie: string; userId: string };
  let roleId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    member = await createMemberSession(app, db, { role: 'member' });
    const res = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ name: ROLE }),
    });
    expect(res.status).toBeLessThan(300);
    roleId = ((await res.json()) as { role: { id: string } }).role.id;
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${ROLE} OR v1 = ${ROLE}`
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zv_roles')
      .where('name', '=', ROLE)
      .execute()
      .catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('offers a collection the actions the data API checks', async () => {
    const res = await app.request('/api/admin/resources', { headers: { cookie: god } });
    const { resources } = (await res.json()) as {
      resources: Array<{ name: string; actions: string[] }>;
    };
    const mine = resources.find((r) => r.name === COLLECTION);
    expect(mine?.actions).toEqual(['read', 'create', 'update', 'delete']);
  });

  it('a role granted the offered read action can read the collection', async () => {
    const res = await app.request('/api/admin/resources', { headers: { cookie: god } });
    const { resources } = (await res.json()) as {
      resources: Array<{ name: string; actions: string[] }>;
    };
    const readAction = resources.find((r) => r.name === COLLECTION)?.actions[0];

    const bulk = await app.request('/api/admin/permissions/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        permissions: [{ role_id: roleId, resource: COLLECTION, action: readAction }],
      }),
    });
    expect(bulk.status).toBe(200);
    const assign = await app.request('/api/permissions/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ userId: member.userId, role: ROLE }),
    });
    expect(assign.status).toBeLessThan(300);

    const read = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie: member.cookie },
    });
    expect(read.status).toBe(200);
  });

  it('saves back a role’s execute grant, which extension actions ask for', async () => {
    // Granted outside the matrix, as `POST /api/permissions/policies` does.
    const grant = await app.request('/api/permissions/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ subject: ROLE, resource: `${COLLECTION}_res`, action: 'execute' }),
    });
    expect(grant.status).toBe(200);
    // The screen saves every grant it loaded, so one it refuses makes it unsavable.
    const loaded = (await (
      await app.request('/api/admin/permissions', { headers: { cookie: god } })
    ).json()) as { permissions: Array<{ role_id: string; resource: string; action: string }> };
    const mine = loaded.permissions.filter((p) => p.role_id === roleId);
    expect(mine.map((p) => p.action)).toContain('execute');
    const bulk = await app.request('/api/admin/permissions/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ permissions: mine }),
    });
    expect(bulk.status).toBe(200);
  });

  it('offers what an installed extension declares, with execute, and a declared collection once, with execute', async () => {
    const ext = `permmatrix_ext_${Date.now()}`;
    const declared = `${ext}_res`;
    const root = mkdtempSync(join(tmpdir(), 'permmatrix-ext-'));
    const saved = process.env.EXTENSIONS_DIR;
    mkdirSync(join(root, ext), { recursive: true });
    writeFileSync(
      join(root, ext, 'manifest.json'),
      JSON.stringify({ name: ext, resources: [declared, COLLECTION] }),
    );
    process.env.EXTENSIONS_DIR = root;
    try {
      await sql`
        INSERT INTO zv_extension_registry (name, display_name, version, is_installed, is_enabled)
        VALUES (${ext}, 'Matrix Test', '1.0.0', true, false)
      `.execute(db);
      // As the install route does: the claim is read from the row.
      await recordManifest(db, ext, join(root, ext));
      const res = await app.request('/api/admin/resources', { headers: { cookie: god } });
      const { resources } = (await res.json()) as {
        resources: Array<{ name: string; type: string; actions: string[] }>;
      };
      expect(resources.find((r) => r.name === declared)).toEqual({
        name: declared,
        display_name: declared,
        type: 'extension',
        actions: ['read', 'create', 'update', 'delete', 'execute'],
      } as never);
      // Listed once, as the collection — and with execute, which the extension's
      // actions gated on it ask for.
      expect(
        resources.filter((r) => r.name === COLLECTION).map((r) => [r.type, r.actions]),
      ).toEqual([['collection', ['read', 'create', 'update', 'delete', 'execute']]]);
    } finally {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${ext}`.execute(db);
      if (saved === undefined) delete process.env.EXTENSIONS_DIR;
      else process.env.EXTENSIONS_DIR = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
