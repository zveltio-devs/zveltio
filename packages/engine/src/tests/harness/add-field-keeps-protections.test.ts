/**
 * A field added in place changes nothing about its table but the column, its
 * grants and the masking view's column list (ADR 0041, decision 3).
 *
 * The table carries every protection the engine puts on one (LV-12): a sealed
 * column, a column permission (masking view and column guard), a row rule, a
 * unique key, and foreign keys in both directions. A field is then added
 * through a schema-branch merge — `runAddField`, the road that once copied a
 * large table and swapped it in — and the whole catalog of the table is
 * compared before and after (`catalogState`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  catalogState,
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = Date.now();
const TARGET = `hafp_tgt_${SFX}`;
const MAIN = `hafp_${SFX}`;
const REFERRER = `hafp_ref_${SFX}`;
const TABLE = `zvd_${MAIN}`;

const text = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
  ...over,
});

d('a field added in place keeps every protection of its table', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const post = async (path: string, body: unknown) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    if (res.status >= 300) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as Record<string, unknown>;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, { name: TARGET, fields: [text('label')] } as never);
    await DDLManager.createCollection(db, {
      name: MAIN,
      fields: [
        text('title', { required: true }),
        text('code', { unique: true }),
        text('status', { indexed: true }),
        { name: 'salary', type: 'number', required: false },
        { name: 'pw', type: 'password', required: false },
        {
          name: 'owner_ref',
          type: 'm2o',
          required: false,
          options: { related_collection: TARGET },
        },
      ],
    } as never);
    await DDLManager.createCollection(db, {
      name: REFERRER,
      fields: [
        text('label'),
        { name: 'main_ref', type: 'm2o', required: false, options: { related_collection: MAIN } },
      ],
    } as never);
    await post('/api/admin/column-permissions', {
      collection_name: MAIN,
      column_name: 'salary',
      role: 'member',
      can_read: false,
      can_write: false,
    });
    await post('/api/admin/rls', {
      collection: MAIN,
      role: 'member',
      filter_field: 'status',
      filter_op: 'eq',
      filter_value_source: 'static:published',
    });
    await sql`ANALYZE ${sql.table(TABLE)}`.execute(db);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${MAIN}`.execute(db).catch(() => {});
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${MAIN}`
      .execute(db)
      .catch(() => {});
    for (const c of [REFERRER, MAIN, TARGET]) await dropTestCollection(db, c).catch(() => {});
  });

  it('differs only by the column, its grants and the view', async () => {
    const before = await catalogState(db, TABLE);
    // The fixture really has what the comparison is about.
    const has = (re: RegExp) =>
      expect(
        before.some((l) => re.test(l)),
        String(re),
      ).toBe(true);
    has(/^01 class\|.* rls=t force=t /);
    has(/^05 constraint\|\S+ on \S+: UNIQUE \(tenant_id, code\)/);
    has(/^05 constraint\|\S+ on \S+: FOREIGN KEY \(owner_ref\) REFERENCES zvd_hafp_tgt_/);
    has(new RegExp(`^05 constraint\\|\\S+ on zvd_${REFERRER}: FOREIGN KEY \\(main_ref\\)`));
    has(/^07 trigger\|CREATE TRIGGER _zv_column_guard /);
    has(/^08 policy\|.*status/);
    has(/^09 view\|zvv_hafp_\d+ .*THEN salary ELSE NULL/);
    // Sealed: no request role is granted the password column.
    expect(before.filter((l) => l.startsWith('04 column acl|pw:'))).toEqual([]);

    const { branch, schema } = (await post('/api/schema/branches', { name: `hafp-${SFX}` })) as {
      branch: { id: string };
      schema: string;
    };
    try {
      await post(`/api/schema/branches/${branch.id}/changes`, {
        type: 'add_field',
        payload: { collection: MAIN, field: text('note') },
      });
      // A unique one too: its key is built CONCURRENTLY and attached (DR-37).
      await post(`/api/schema/branches/${branch.id}/changes`, {
        type: 'add_field',
        payload: { collection: MAIN, field: text('sku', { unique: true }) },
      });
      const merged = await post(`/api/schema/branches/${branch.id}/merge`, {});
      expect(merged.errors).toEqual([]);
    } finally {
      await db.deleteFrom('zv_schema_branches').where('id', '=', branch.id).execute();
      await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);
    }

    const after = await catalogState(db, TABLE);
    const added = after.filter((l) => !before.includes(l));
    const removed = before.filter((l) => !after.includes(l));
    const view = (lines: string[]) => lines.filter((l) => l.startsWith('09 view|'));

    // The columns, as any plain text column is.
    expect(added.filter((l) => l.startsWith('03 column|'))).toEqual([
      expect.stringMatching(/^03 column\|note text notnull=f default= /),
      expect.stringMatching(/^03 column\|sku text notnull=f default= /),
    ]);
    // Its grants: exactly those of another plain text column.
    const grantsOf = (lines: string[], col: string) =>
      lines
        .filter((l) => l.startsWith(`04 column acl|${col}: `))
        .map((l) => l.replace(`|${col}: `, '|<col>: '));
    expect(grantsOf(added, 'note').length).toBeGreaterThan(0);
    expect(grantsOf(added, 'note')).toEqual(grantsOf(before, 'title'));
    expect(grantsOf(added, 'sku')).toEqual(grantsOf(before, 'title'));
    // The key: the constraint and its valid index, exactly as the table's own
    // unique field `code` got them at create.
    const keyOf = (lines: string[], col: string) =>
      lines
        .filter(
          (l) =>
            /^(05|06|10) /.test(l) &&
            (l.includes(`tenant_id, ${col})`) || l.includes(`_tenant_id_${col}_key `)),
        )
        .map((l) => l.replaceAll(col, '<col>'));
    expect(keyOf(added, 'sku')).toHaveLength(3);
    expect(keyOf(added, 'sku')).toEqual(keyOf(before, 'code'));
    // The view: the same definition, options and grants, with the column added.
    expect(removed).toEqual(view(before));
    expect(view(added)).toHaveLength(1);
    expect(view(added)[0]!.replace(', note, sku FROM ', ' FROM ')).toBe(view(before)[0]);
    // Nothing else.
    expect(
      added.filter(
        (l) => !/^(03 column|04 column acl|09 view)\|/.test(l) && keyOf([l], 'sku').length === 0,
      ),
      'lines only the add produced',
    ).toEqual([]);
    // No table was swapped: nothing an old copy would have left behind.
    const left = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_class WHERE relname LIKE ${'\\_zv\\_%'} AND relkind = 'r'
    `.execute(db);
    expect(left.rows[0]?.n).toBe(0);
  }, 120_000);
});
