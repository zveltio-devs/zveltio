/**
 * `POST /api/admin/schema/apply` (RFC schema-as-code, step 3a).
 *
 * The test that matters is the round trip: edit the pulled files, apply them,
 * and the next plan against the same files is empty — the instance now says
 * what the files say. The refusals are checked by what did NOT change.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { serialize } from '../../lib/schema-artifact/export.js';
import {
  asDefaultTenant,
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  jobOutcome,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const EXISTING = 'schema_apply_probe';
const CREATED = 'schema_apply_new';
const ROLE = 'schema_apply_role';
const HIDDEN = 'schema_apply_hidden';
const BARE = 'schema_apply_bare';

d('schema apply', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  const call = (route: 'apply' | 'plan', files: unknown) =>
    app.request(`/api/admin/schema/${route}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ files }),
    });

  /** An apply with steps is a job (DR-36): how it ended. */
  const applied = async (files: unknown) => jobOutcome(app, await call('apply', files), { cookie });

  const pull = async () => {
    const res = await app.request('/api/admin/schema/export', { headers: { cookie } });
    return ((await res.json()) as { files: Record<string, string> }).files;
  };

  const columns = async (table: string) =>
    (
      await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns WHERE table_name = ${table}`.execute(db)
    ).rows.map((r) => r.column_name);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: EXISTING,
      displayName: 'Probe',
      fields: [{ name: 'title', type: 'text' }],
    } as never);
  });

  afterAll(async () => {
    // The engine's default grants on both collections too, so a rerun on this
    // database starts from what a fresh one has.
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${ROLE} OR v2 IN (${CREATED}, ${EXISTING})`.execute(
      db,
    );
    await sql`DELETE FROM zv_roles WHERE name = ${ROLE}`.execute(db);
    await sql`DELETE FROM zvd_rls_policies WHERE role = ${ROLE}`.execute(db);
    await sql`DELETE FROM zvd_column_permissions WHERE role = ${ROLE}`.execute(db);
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${EXISTING}`.execute(db);
    await sql`DELETE FROM zvd_collections WHERE name = ${HIDDEN}`.execute(db);
    await sql`DROP TABLE IF EXISTS ${sql.id(`zvd_${BARE}`)}`.execute(db);
    await dropTestCollection(db, CREATED);
    await dropTestCollection(db, EXISTING);
  });

  it('applies additions, after which the same files plan nothing', async () => {
    const files = await pull();
    const path = `collections/${EXISTING}.json`;
    const probe = JSON.parse(files[path]);
    probe.displayName = 'Probe renamed';
    probe.fields.push({ name: 'summary', type: 'text', indexed: true });
    const roles = JSON.parse(files['roles.json']);
    roles.roles.push({
      name: ROLE,
      description: 'Applied from files',
      permissions: [{ resource: CREATED, actions: ['read'] }],
    });
    const edited = {
      ...files,
      [path]: serialize(probe),
      [`collections/${CREATED}.json`]: serialize({
        name: CREATED,
        displayName: 'New',
        fields: [{ name: 'label', type: 'text', required: true }],
      }),
      'roles.json': serialize(roles),
    };

    const res = await call('apply', edited);
    expect(await jobOutcome(app, res, { cookie })).toBe('completed');
    const { steps } = (await res.json()) as { steps: { action: string }[] };
    expect(steps.map((s) => s.action)).toEqual([
      'create collection (1 fields)',
      'set displayName "Probe" → "Probe renamed"',
      'add field summary (text)',
      'create role',
      `grant ${CREATED} read`,
    ]);

    expect(await columns(`zvd_${EXISTING}`)).toContain('summary');
    expect(await columns(`zvd_${CREATED}`)).toContain('label');
    const plan = await call('plan', edited);
    expect(((await plan.json()) as { steps: unknown[] }).steps).toEqual([]);
  });

  it('writes and removes rules, permissions, validations and grants, and reorders fields', async () => {
    const files = await pull();
    const path = `collections/${EXISTING}.json`;
    const probe = JSON.parse(files[path]);
    probe.fields.unshift(probe.fields.pop()); // summary before title
    probe.rowRules = [{ role: ROLE, field: 'title', op: 'eq', value: 'static:x', enabled: false }];
    probe.columnPermissions = [{ role: ROLE, column: 'title', read: true, write: false }];
    probe.validation = [
      { field: 'title', rule: 'length', config: { max: 9 }, message: 'Too long' },
    ];
    const roles = JSON.parse(files['roles.json']);
    const role = roles.roles.find((r: { name: string }) => r.name === ROLE);
    role.description = 'Changed';
    role.permissions = [{ resource: EXISTING, actions: ['read'] }];
    const edited = { ...files, [path]: serialize(probe), 'roles.json': serialize(roles) };

    const res = await call('apply', edited);
    expect(await jobOutcome(app, res, { cookie })).toBe('completed');
    expect(await pull()).toEqual(edited);

    // Change each entry in place, then take every one away again.
    delete probe.rowRules[0].enabled;
    probe.validation[0].message = 'Way too long';
    probe.columnPermissions[0].write = true;
    const altered = { ...edited, [path]: serialize(probe) };
    expect(await applied(altered)).toBe('completed');
    expect(await pull()).toEqual(altered);

    probe.rowRules = [];
    probe.columnPermissions = [];
    probe.validation = [];
    const removed = { ...altered, [path]: serialize(probe) };
    expect(await applied(removed)).toBe('completed');
    expect(await pull()).toEqual(removed);
  });

  it('revokes and grants what the table holds, even when this instance has not loaded it', async () => {
    // Written beside the enforcer — another replica whose bus message was
    // lost, or psql — so the table and this instance's model disagree. Casbin
    // skips a remove the model lacks and an add the model holds, without
    // touching the table, and the plan is read from the table.
    await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
              VALUES ('p', ${ROLE}, '*', ${EXISTING}, 'delete')`.execute(db);
    const files = await pull();
    const roles = JSON.parse(files['roles.json']);
    const role = roles.roles.find((r: { name: string }) => r.name === ROLE);
    expect(role.permissions).toEqual([{ resource: EXISTING, actions: ['delete', 'read'] }]);
    role.permissions = [{ resource: EXISTING, actions: ['read'] }];
    const edited = { ...files, 'roles.json': serialize(roles) };
    expect(await applied(edited)).toBe('completed');
    expect(await pull()).toEqual(edited);

    await sql`DELETE FROM zvd_permissions
              WHERE v0 = ${ROLE} AND v2 = ${EXISTING} AND v3 = 'read'`.execute(db);
    expect(await applied(edited)).toBe('completed');
    expect(await pull()).toEqual(edited);
  });

  it("alters a field's required flag and label, and refuses what it cannot alter yet", async () => {
    const files = await pull();
    const path = `collections/${EXISTING}.json`;
    const probe = JSON.parse(files[path]);
    const title = probe.fields.find((f: { name: string }) => f.name === 'title');
    title.required = true;
    title.label = 'Title';
    const edited = { ...files, [path]: serialize(probe) };
    expect(await applied(edited)).toBe('completed');
    expect(await pull()).toEqual(edited);
    const notNull = await asDefaultTenant(
      db,
      sql<{ is_nullable: string }>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_name = ${`zvd_${EXISTING}`} AND column_name = 'title'`,
    );
    expect(notNull.rows[0].is_nullable).toBe('NO');

    title.encrypted = true;
    const res = await call('apply', { ...edited, [path]: serialize(probe) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toContain(
      'alter field title (encrypted)',
    );
  });

  it("alters a field's unique key, index and default, and takes them away again", async () => {
    const files = await pull();
    const path = `collections/${EXISTING}.json`;
    const table = `zvd_${EXISTING}`;
    const probe = JSON.parse(files[path]);
    const title = probe.fields.find((f: { name: string }) => f.name === 'title');
    const keys = async () => {
      const r = await sql<{ def: string }>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = to_regclass(${table}) AND contype = 'u'
        UNION ALL
        SELECT indexdef FROM pg_indexes WHERE tablename = ${table} AND indexdef LIKE '%(title)%'
        UNION ALL
        SELECT indexdef FROM pg_indexes WHERE tablename = ${table} AND indexdef LIKE '%, title,%'
        UNION ALL
        SELECT 'default ' || column_default FROM information_schema.columns
         WHERE table_name = ${table} AND column_name = 'title' AND column_default IS NOT NULL`.execute(
        db,
      );
      return r.rows.map((x) => x.def).sort();
    };
    const before = await keys();

    title.unique = true;
    title.indexed = true;
    title.defaultValue = 'untitled';
    const edited = { ...files, [path]: serialize(probe) };
    expect(await applied(edited)).toBe('completed');
    expect(await pull()).toEqual(edited);
    const on = await keys();
    expect(on).toContain('UNIQUE (tenant_id, title)');
    expect(on.some((k) => k.includes('USING btree (title)'))).toBe(true);
    expect(on.some((k) => k.includes('(tenant_id, title, created_at DESC)'))).toBe(true);
    expect(on).toContain("default 'untitled'::text");
    expect(((await (await call('plan', edited)).json()) as { steps: unknown[] }).steps).toEqual([]);

    delete title.unique;
    delete title.indexed;
    delete title.defaultValue;
    const back = { ...files, [path]: serialize(probe) };
    expect(await applied(back)).toBe('completed');
    expect(await pull()).toEqual(back);
    expect(await keys()).toEqual(before);
  });

  it('refuses a row rule the engine cannot enforce', async () => {
    const files = await pull();
    const path = `collections/${EXISTING}.json`;
    const probe = JSON.parse(files[path]);
    probe.rowRules = [{ role: ROLE, field: 'title', op: 'eq', value: 'nonsense' }];
    // Checked while the apply runs, against the columns the steps before it
    // made: the job fails with the reason.
    expect(await applied({ ...files, [path]: serialize(probe) })).toContain(
      'failed: schema_apply_probe row rule',
    );
  });

  it('vets custom and transition expressions as the validation rules API does', async () => {
    const files = await pull();
    const path = `collections/${EXISTING}.json`;
    const probe = JSON.parse(files[path]);
    const withRule = (rule: string, expression: string) => {
      probe.validation = [{ field: 'title', rule, config: { expression }, message: 'No' }];
      return call('apply', { ...files, [path]: serialize(probe) });
    };
    // `previous` is in scope for a transition rule only.
    const custom = await withRule('custom', 'value == previous');
    expect(custom.status).toBe(400);
    expect(((await custom.json()) as { detail: string }).detail).toContain('the expression');
    expect((await withRule('transition', 'value == (')).status).toBe(400);
    expect(
      await jobOutcome(app, await withRule('transition', 'value == previous'), { cookie }),
    ).toBe('completed');
    probe.validation = [];
    expect(await applied({ ...files, [path]: serialize(probe) })).toBe('completed');
  });

  it('refuses a plan with a step it cannot run yet, and changes nothing', async () => {
    const files = await pull();
    const path = `collections/${EXISTING}.json`;
    const probe = JSON.parse(files[path]);
    const icon = probe.icon;
    probe.icon = 'star';
    const { [`collections/${CREATED}.json`]: _dropped, ...rest } = files;
    const res = await call('apply', { ...rest, [path]: serialize(probe) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain(`- ${CREATED} drop collection`);
    // The icon step was runnable, and still did not run.
    expect(JSON.parse((await pull())[path]).icon).toBe(icon);
    expect(await DDLManager.tableExists(db, CREATED)).toBe(true);
  });

  it('refuses an invalid file before running any step', async () => {
    const files = await pull();
    const path = `collections/${EXISTING}.json`;
    const probe = JSON.parse(files[path]);
    probe.fields.push({ name: 'ok_field', type: 'text' });
    probe.fields.push({ name: 'bad_field', type: 'no_such_type' });
    const res = await call('apply', { ...files, [path]: serialize(probe) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain('no_such_type');
    expect(await columns(`zvd_${EXISTING}`)).not.toContain('ok_field');
  });

  it('will not create a collection over one the files do not hold', async () => {
    // An engine collection (in the catalog, left out of the export) and a bare
    // table (no catalog row): the plan sees neither, so both look new to it.
    await sql`INSERT INTO zvd_collections (name, display_name, fields, is_system)
              VALUES (${HIDDEN}, 'Hidden', '[]'::jsonb, true)`.execute(db);
    await sql`CREATE TABLE ${sql.id(`zvd_${BARE}`)} (id uuid)`.execute(db);
    const files = await pull();
    for (const name of [HIDDEN, BARE]) {
      const res = await call('apply', {
        ...files,
        [`collections/${name}.json`]: serialize({ name, fields: [{ name: 'x', type: 'text' }] }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { detail: string }).detail).toContain(
        'outside the schema files',
      );
    }
  });

  // DR-36: an apply runs for as long as its steps take, so it is a job. The
  // answer is the plan and a job to poll; the job's result is the steps it ran.
  it('answers 202 with the plan and a job whose result is the steps it ran', async () => {
    const files = await pull();
    const path = `collections/${EXISTING}.json`;
    const probe = JSON.parse(files[path]);
    probe.fields.push({ name: 'by_job', type: 'text' });
    const res = await call('apply', { ...files, [path]: serialize(probe) });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { job_id: string; steps: { action: string }[] };
    expect(body.steps.map((s) => s.action)).toEqual(['add field by_job (text)']);
    const job = await app.request(`/api/collections/jobs/${body.job_id}`, { headers: { cookie } });
    expect(((await job.json()) as { job: unknown }).job).toMatchObject({
      type: 'apply_schema',
      status: 'completed',
      error: null,
      result: { steps: [{ action: 'add field by_job (text)' }] },
    });
    expect(await columns(`zvd_${EXISTING}`)).toContain('by_job');
    // Nothing left to do is no job.
    const again = await call('apply', { ...files, [path]: serialize(probe) });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { steps: unknown[] }).steps).toEqual([]);
  });

  it('is refused without an instance admin', async () => {
    expect((await app.request('/api/admin/schema/apply', { method: 'POST' })).status).toBe(401);
  });
});
