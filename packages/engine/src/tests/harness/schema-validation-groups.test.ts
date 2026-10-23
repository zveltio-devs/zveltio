/**
 * The schema artifact carries validation rule groups (migration 091).
 *
 * Measured on master: `exportSchema` wrote a collection's validation rules and
 * nothing about `zvd_validation_rule_groups`, so a pull from an instance whose
 * `tax_id` rules were OR-ed by a group, applied to another instance, gave back
 * the rules with every one required — the group was simply gone. A group also
 * names its members by `zv_validation_rules.id`, which no other instance shares.
 *
 * Now the collection file has `validationGroups`, each member written as the
 * rule's natural key in the artifact (field from the group, `rule`, `config`),
 * and apply resolves those keys to the target's own rule ids. A member that no
 * rule in the files answers, a name twice, or an instance without the
 * extension's table is refused before anything changes. Format 2: a format-1
 * file, which knows no groups, would otherwise plan every group away.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { toJsonb } from '../../lib/jsonb.js';
import { serialize } from '../../lib/schema-artifact/export.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const C = `schema_vgroups_${Date.now()}`;
const PATH = `collections/${C}.json`;
const T = 'zvd_validation_rule_groups';

d('schema artifact: validation rule groups', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let createdTable = false;
  const original: string[] = [];

  const call = (route: 'apply' | 'plan', files: unknown) =>
    app.request(`/api/admin/schema/${route}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ files }),
    });
  const pull = async () => {
    const res = await app.request('/api/admin/schema/export', { headers: { cookie } });
    return ((await res.json()) as { files: Record<string, string> }).files;
  };
  // A uuid[] arrives as its text form (see toIdArray), so it is read joined.
  const group = async () => {
    const g = (
      await sql<{ logic: string; field_name: string; ids: string }>`
        SELECT logic, field_name, array_to_string(rule_ids, ',') AS ids
          FROM zvd_validation_rule_groups
         WHERE collection = ${C} AND name = 'tax_either'`.execute(db)
    ).rows[0];
    return g && { logic: g.logic, field_name: g.field_name, rule_ids: g.ids.split(',') };
  };
  const rules = async () =>
    (
      await sql<{ id: string; rule_type: string }>`
        SELECT id, rule_type FROM zv_validation_rules WHERE collection = ${C}
         ORDER BY rule_type`.execute(db)
    ).rows;
  const edit = (files: Record<string, string>, change: (col: Record<string, unknown>) => void) => {
    const col = JSON.parse(files[PATH]!) as Record<string, unknown>;
    change(col);
    return { ...files, [PATH]: serialize(col) };
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    // The developer/validation extension's table, in its shape after 091.
    createdTable = !(
      await sql<{ ok: boolean }>`SELECT to_regclass(${T}) IS NOT NULL AS ok`.execute(db)
    ).rows[0]!.ok;
    await sql`CREATE TABLE IF NOT EXISTS zvd_validation_rule_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
      collection TEXT NOT NULL, field_name TEXT NOT NULL, description TEXT,
      logic TEXT NOT NULL DEFAULT 'AND' CHECK (logic IN ('AND','OR')),
      rule_ids UUID[] NOT NULL DEFAULT '{}', is_active BOOLEAN NOT NULL DEFAULT true,
      created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`.execute(db);
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS zvd_validation_rule_groups_collection_name
      ON zvd_validation_rule_groups (collection, name)`.execute(db);

    await DDLManager.createCollection(db, {
      name: C,
      displayName: 'Groups probe',
      fields: [
        { name: 'tax_id', type: 'text' },
        { name: 'title', type: 'text' },
      ],
    } as never);
    for (const [rule, config] of [
      ['pattern', { pattern: '^RO[0-9]+$' }],
      ['minLength', { value: 12 }],
    ] as const) {
      const r = await db
        .insertInto('zv_validation_rules')
        .values({
          collection: C,
          field_name: 'tax_id',
          rule_type: rule,
          rule_config: toJsonb(config),
          error_message: `${rule} failed`,
          is_active: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      original.push(r.id);
    }
    await sql`INSERT INTO zvd_validation_rule_groups
                (name, collection, field_name, logic, rule_ids, created_by)
              VALUES ('tax_either', ${C}, 'tax_id', 'OR', ${original}::uuid[], 'test')`.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${C}`.execute(db);
    if (createdTable) await sql`DROP TABLE IF EXISTS zvd_validation_rule_groups`.execute(db);
    else await sql`DELETE FROM zvd_validation_rule_groups WHERE collection = ${C}`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v2 = ${C}`.execute(db);
    await dropTestCollection(db, C);
  });

  let pulled: Record<string, string>;

  it('a pull writes the group with its members by key, not by id', async () => {
    pulled = await pull();
    expect(JSON.parse(pulled['zveltio-schema.json']!).format).toBe(2);
    const col = JSON.parse(pulled[PATH]!) as Record<string, unknown>;
    expect(col.validationGroups).toEqual([
      {
        field: 'tax_id',
        logic: 'OR',
        name: 'tax_either',
        rules: [
          { config: { value: 12 }, rule: 'minLength' },
          { config: { pattern: '^RO[0-9]+$' }, rule: 'pattern' },
        ],
      },
    ]);
    for (const id of original) expect(pulled[PATH]).not.toContain(id);
  });

  it('applied to an instance without them, reproduces the group over its own rule ids', async () => {
    // The other instance: no rules, no group.
    await sql`DELETE FROM zvd_validation_rule_groups WHERE collection = ${C}`.execute(db);
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${C}`.execute(db);

    const res = await call('apply', pulled);
    expect(res.status).toBe(200);
    const now = await rules();
    expect(now.map((r) => r.rule_type)).toEqual(['minLength', 'pattern']);
    for (const r of now) expect(original).not.toContain(r.id);
    const g = await group();
    expect(g?.logic).toBe('OR');
    expect(g?.field_name).toBe('tax_id');
    expect([...(g?.rule_ids ?? [])].sort()).toEqual(now.map((r) => r.id).sort());
    // The instance now says what the files say.
    const again = (await (await call('plan', pulled)).json()) as { steps: unknown[] };
    expect(again.steps).toEqual([]);
  });

  it('changes a group in place, and removes one the files no longer have', async () => {
    const and = edit(pulled, (col) => {
      const [g] = col.validationGroups as Record<string, unknown>[];
      g!.logic = 'AND';
      g!.rules = [{ rule: 'pattern', config: { pattern: '^RO[0-9]+$' } }];
    });
    expect((await call('apply', and)).status).toBe(200);
    const g = await group();
    const pattern = (await rules()).find((r) => r.rule_type === 'pattern')!;
    expect(g?.logic).toBe('AND');
    expect(g?.rule_ids).toEqual([pattern.id]);

    const none = edit(pulled, (col) => {
      col.validationGroups = [];
    });
    expect((await call('apply', none)).status).toBe(200);
    expect(await group()).toBeUndefined();
    expect((await call('apply', pulled)).status).toBe(200);
  });

  it('refuses a member no rule in the files answers, and changes nothing', async () => {
    const before = await group();
    const dangling = edit(pulled, (col) => {
      const [g] = col.validationGroups as Record<string, unknown>[];
      g!.logic = 'AND';
      g!.rules = [{ rule: 'maxLength', config: { value: 3 } }];
    });
    const res = await call('apply', dangling);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain('tax_either');
    expect(await group()).toEqual(before);

    // Another field's rule is not a member either.
    const otherField = edit(pulled, (col) => {
      (col.validation as Record<string, unknown>[]).push({
        field: 'title',
        rule: 'maxLength',
        config: { value: 3 },
        message: 'too long',
      });
      const [g] = col.validationGroups as Record<string, unknown>[];
      g!.rules = [{ rule: 'maxLength', config: { value: 3 } }];
    });
    expect((await call('apply', otherField)).status).toBe(400);
    expect(await group()).toEqual(before);

    // Two instance rules with one key: the file cannot say which is the member.
    await sql`INSERT INTO zv_validation_rules
                (collection, field_name, rule_type, rule_config, error_message)
              SELECT collection, field_name, rule_type, rule_config, error_message
                FROM zv_validation_rules WHERE collection = ${C} AND rule_type = 'pattern'`.execute(
      db,
    );
    const and = edit(pulled, (col) => {
      (col.validationGroups as Record<string, unknown>[])[0]!.logic = 'AND';
    });
    const ambiguous = await call('apply', and);
    expect(ambiguous.status).toBe(400);
    expect(((await ambiguous.json()) as { detail: string }).detail).toContain('more than one');
    expect(await group()).toEqual(before);
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${C} AND rule_type = 'pattern'
                AND id <> ALL(${before!.rule_ids}::uuid[])`.execute(db);
  });

  it('refuses a group name twice in one collection', async () => {
    const twice = edit(pulled, (col) => {
      const [g] = col.validationGroups as Record<string, unknown>[];
      col.validationGroups = [g, { ...g, field: 'title', rules: [] }];
    });
    const res = await call('plan', twice);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain('tax_either twice');
  });

  it('refuses a format-1 file, which would plan every group away', async () => {
    const old = { ...pulled, 'zveltio-schema.json': serialize({ format: 1 }) };
    expect((await call('plan', old)).status).toBe(400);
  });

  it('refuses groups on an instance without the extension table, before any change', async () => {
    if (!createdTable) return; // the extension is really installed here
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${C}`.execute(db);
    await sql`DROP TABLE zvd_validation_rule_groups`.execute(db);
    const res = await call('apply', pulled);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain('developer/validation');
    expect(await rules()).toEqual([]);
  });
});
