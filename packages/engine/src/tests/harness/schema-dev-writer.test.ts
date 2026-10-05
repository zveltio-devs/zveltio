/**
 * Studio's dev-mode writer (RFC schema-as-code §7): with ZVELTIO_SCHEMA_DIR set
 * outside production, a change made through the routes rewrites `schema/`, and
 * a rename, type change or drop also writes its migration, recorded as applied.
 * The proof is the plan: the written directory against the instance plans
 * nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { schemaWriteSettled } from '../../lib/schema-artifact/dev-writer.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COL = 'schema_devw_probe';
const ROLE = 'schema_devw_role';

d('schema dev writer', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let dir: string;
  const before = { dir: process.env.ZVELTIO_SCHEMA_DIR, env: process.env.NODE_ENV };

  const req = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await schemaWriteSettled();
    return res;
  };

  /** Every file under `dir`, as the CLI sends them. */
  const files = () => {
    const out: Record<string, string> = {};
    for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (f.isFile()) {
        const p = join(f.parentPath, f.name);
        out[relative(dir, p)] = readFileSync(p, 'utf8');
      }
    }
    return out;
  };
  const migrations = () => Object.keys(files()).filter((p) => p.startsWith('migrations/'));
  const lastOps = () => {
    const last = migrations().sort().at(-1)!;
    return JSON.parse(files()[last]).ops;
  };
  const planSteps = async () => {
    const res = await req('POST', '/api/admin/schema/plan', { files: files() });
    expect(res.status).toBe(200);
    return ((await res.json()) as { steps: unknown[] }).steps;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    dir = mkdtempSync(join(tmpdir(), 'zv-devw-'));
    process.env.ZVELTIO_SCHEMA_DIR = dir;
    await DDLManager.createCollection(db, {
      name: COL,
      fields: [
        { name: 'title', type: 'text' },
        { name: 'qty', type: 'text' },
        { name: 'note', type: 'text' },
      ],
    } as never);
    await sql`INSERT INTO zv_roles (name) VALUES (${ROLE})`.execute(db);
  });

  afterAll(async () => {
    process.env.ZVELTIO_SCHEMA_DIR = before.dir;
    process.env.NODE_ENV = before.env;
    const ids = readdirSync(join(dir, 'migrations')).map((f) => f.replace(/\.json$/, ''));
    if (ids.length)
      await sql`DELETE FROM zv_schema_migrations WHERE id IN (${sql.join(ids)})`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${ROLE} OR v2 = ${COL}`.execute(db);
    await sql`DELETE FROM zv_roles WHERE name = ${ROLE}`.execute(db);
    await dropTestCollection(db, COL);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a type change and a rename write the state and one migration, already applied', async () => {
    const res = await req('PATCH', `/api/collections/${COL}/fields/qty`, {
      new_name: 'amount',
      new_type: 'integer',
    });
    expect(res.status).toBe(200);
    const probe = JSON.parse(files()[`collections/${COL}.json`]);
    expect(probe.fields.map((f: { name: string }) => f.name)).toEqual(['title', 'amount', 'note']);
    expect(lastOps()).toEqual([
      { op: 'changeFieldType', collection: COL, field: 'qty', to: 'integer' },
      { op: 'renameField', collection: COL, from: 'qty', to: 'amount' },
    ]);
    expect(await planSteps()).toEqual([]);
  });

  it('a field-only change writes no migration', async () => {
    const n = migrations().length;
    expect(
      (await req('PATCH', `/api/collections/${COL}/fields/title`, { indexed: true })).status,
    ).toBe(200);
    expect(migrations().length).toBe(n);
    expect(JSON.parse(files()[`collections/${COL}.json`]).fields[0].indexed).toBe(true);
    expect(await planSteps()).toEqual([]);
  });

  it('a dropped field writes dropField', async () => {
    expect((await req('DELETE', `/api/collections/${COL}/fields/note`)).status).toBe(200);
    expect(lastOps()).toEqual([{ op: 'dropField', collection: COL, field: 'note' }]);
    expect(await planSteps()).toEqual([]);
  });

  it('a removed role writes dropRole', async () => {
    const { id } = await db
      .selectFrom('zv_roles')
      .select('id')
      .where('name', '=', ROLE)
      .executeTakeFirstOrThrow();
    expect(files()['roles.json']).toContain(ROLE);
    expect((await req('DELETE', `/api/admin/roles/${id}`)).status).toBe(200);
    expect(lastOps()).toEqual([{ op: 'dropRole', role: ROLE }]);
    expect(files()['roles.json']).not.toContain(ROLE);
    expect(await planSteps()).toEqual([]);
  });

  it('in production nothing is written', async () => {
    process.env.NODE_ENV = 'production';
    try {
      const n = migrations().length;
      expect(
        (await req('PATCH', `/api/collections/${COL}/fields/title`, { indexed: false })).status,
      ).toBe(200);
      expect(migrations().length).toBe(n);
      expect(JSON.parse(files()[`collections/${COL}.json`]).fields[0].indexed).toBe(true);
    } finally {
      process.env.NODE_ENV = before.env;
    }
    // The next change catches the directory up.
    expect(
      (await req('PATCH', `/api/collections/${COL}/fields/title`, { indexed: true })).status,
    ).toBe(200);
    expect(await planSteps()).toEqual([]);
  });

  it('a dropped collection writes dropCollection and removes its file', async () => {
    expect((await req('DELETE', `/api/collections/${COL}`)).status).toBe(200);
    expect(lastOps()).toEqual([{ op: 'dropCollection', collection: COL }]);
    expect(files()[`collections/${COL}.json`]).toBeUndefined();
    expect(await planSteps()).toEqual([]);
  });
});
