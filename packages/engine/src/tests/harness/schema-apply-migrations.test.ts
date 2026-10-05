/**
 * Schema migrations in `POST /api/admin/schema/apply` (RFC schema-as-code
 * §4.4, §9.3): what a state diff cannot say without guessing — a rename, a
 * type change, a drop, a removed role — said by a `migrations/<id>.json`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { serialize } from '../../lib/schema-artifact/export.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COL = 'schema_mig_probe';
const ROLE = 'schema_mig_role';

d('schema apply migrations', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  const call = (route: 'apply' | 'plan', files: unknown, allowDestructive = false) =>
    app.request(`/api/admin/schema/${route}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ files, allowDestructive }),
    });

  const pull = async () => {
    const res = await app.request('/api/admin/schema/export', { headers: { cookie } });
    return ((await res.json()) as { files: Record<string, string> }).files;
  };

  const columns = async () =>
    (
      await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns WHERE table_name = ${`zvd_${COL}`}`.execute(
        db,
      )
    ).rows.map((r) => r.column_name);

  const migration = (id: string, ops: unknown[]) => ({
    [`migrations/${id}.json`]: serialize({ id, ops }),
  });

  /** The pulled files with the probe collection edited by `edit`. */
  const withProbe = async (edit: (c: { fields: { name: string; type: string }[] }) => void) => {
    const files = await pull();
    const probe = JSON.parse(files[`collections/${COL}.json`]);
    edit(probe);
    return { ...files, [`collections/${COL}.json`]: serialize(probe) };
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COL,
      fields: [
        { name: 'title', type: 'text' },
        { name: 'note', type: 'text' },
      ],
    } as never);
    await sql`INSERT INTO ${sql.id(`zvd_${COL}`)} (title, note) VALUES ('kept', 'n')`.execute(db);
    await sql`INSERT INTO zv_roles (name) VALUES (${ROLE})`.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${ROLE} OR v2 = ${COL}`.execute(db);
    await sql`DELETE FROM zv_roles WHERE name = ${ROLE}`.execute(db);
    await sql`DELETE FROM zv_schema_migrations WHERE id LIKE '20261005T%'`.execute(db);
    await dropTestCollection(db, COL);
  });

  it('refuses a rename without a migration, and keeps the data with one', async () => {
    const renamed = await withProbe((c) => {
      c.fields[0].name = 'headline';
    });
    // Without the migration it reads as drop + add, and the drop has no op.
    const refused = await call('apply', renamed);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { detail: string }).detail).toContain('drop field title');

    const files = {
      ...renamed,
      ...migration('20261005T100000-headline', [
        { op: 'renameField', collection: COL, from: 'title', to: 'headline' },
      ]),
    };
    const res = await call('apply', files);
    expect(res.status).toBe(200);
    const rows = await sql<{
      headline: string;
    }>`SELECT headline FROM ${sql.id(`zvd_${COL}`)}`.execute(db);
    expect(rows.rows.map((r) => r.headline)).toEqual(['kept']);
    // Recorded once: the same files plan nothing.
    const plan = await call('plan', files);
    expect(((await plan.json()) as { steps: unknown[] }).steps).toEqual([]);

    // An applied migration whose file changed is refused.
    const edited = {
      ...files,
      ...migration('20261005T100000-headline', [
        { op: 'renameField', collection: COL, from: 'title', to: 'header' },
      ]),
    };
    const changed = await call('apply', edited);
    expect(changed.status).toBe(400);
    expect(((await changed.json()) as { detail: string }).detail).toContain(
      'changed after it was applied',
    );
  });

  it('runs a drop only with --allow-destructive', async () => {
    const files = {
      ...(await withProbe((c) => {
        c.fields = c.fields.filter((f) => f.name !== 'note');
      })),
      ...migration('20261005T110000-drop-note', [
        { op: 'dropField', collection: COL, field: 'note' },
      ]),
    };
    const refused = await call('apply', files);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { detail: string }).detail).toContain('--allow-destructive');
    expect(await columns()).toContain('note');

    expect((await call('apply', files, true)).status).toBe(200);
    expect(await columns()).not.toContain('note');
  });

  it('refuses to drop a collection DELETE /api/collections refuses', async () => {
    const locked = `${COL}_locked`;
    await DDLManager.createCollection(db, {
      name: locked,
      fields: [{ name: 'title', type: 'text' }],
    } as never);
    try {
      await sql`UPDATE zvd_collections SET schema_locked = true WHERE name = ${locked}`.execute(db);
      DDLManager.invalidateCache(locked);
      const files = await pull();
      delete files[`collections/${locked}.json`];
      const res = await call(
        'apply',
        {
          ...files,
          ...migration('20261005T115000-drop-locked', [
            { op: 'dropCollection', collection: locked },
          ]),
        },
        true,
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { detail: string }).detail).toContain('schema-locked');
      expect(await DDLManager.tableExists(db, locked)).toBe(true);
    } finally {
      await dropTestCollection(db, locked);
    }
  });

  it('removes a custom role, and refuses a built-in one', async () => {
    const files = await pull();
    const roles = JSON.parse(files['roles.json']);
    roles.roles = roles.roles.filter((r: { name: string }) => r.name !== ROLE);
    const dropped = {
      ...files,
      'roles.json': serialize(roles),
      ...migration('20261005T120000-drop-role', [{ op: 'dropRole', role: ROLE }]),
    };
    expect((await call('apply', dropped, true)).status).toBe(200);
    const left = await sql`SELECT 1 FROM zv_roles WHERE name = ${ROLE}`.execute(db);
    expect(left.rows).toEqual([]);

    // Even with a zv_roles row, which the roles API lets anyone create.
    const inserted = await sql`INSERT INTO zv_roles (name) VALUES ('tenant_admin')
      ON CONFLICT (name) DO NOTHING RETURNING name`.execute(db);
    const builtIn = await call(
      'apply',
      {
        ...dropped,
        ...migration('20261005T130000-drop-admin', [{ op: 'dropRole', role: 'tenant_admin' }]),
      },
      true,
    );
    expect(builtIn.status).toBe(400);
    if (inserted.rows.length)
      await sql`DELETE FROM zv_roles WHERE name = 'tenant_admin'`.execute(db);
    expect(((await builtIn.json()) as { detail: string }).detail).toContain('not a custom role');
  });
});
