/**
 * ADR 0050: `GET /api/data/:collection/aggregate` answers the numbers a
 * permitted client computes from the rows and columns its own list returns,
 * never more — pinned per read layer: a row rule, a query alter, a hidden and a
 * masked column, sealed/`secret`/`encrypted` fields, another tenant's rows, the
 * `public` role, an entity-access check (403), the type and syntax refusals
 * (400) and the 5 s ceiling (422).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { underCeiling } from '../../lib/data/handlers/aggregate.js';
import { queryAlterRegistry } from '../../lib/data/query-alter.js';
import { toJsonb } from '../../lib/jsonb.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import {
  entityAccessRegistry,
  getEnforcer,
  invalidateAllPermissionCaches,
  invalidateRlsCache,
} from '../../lib/tenancy/index.js';
import {
  asTenant,
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const COLL = `agg_${SFX}`;
const TABLE = `zvd_${COLL}`;
const VIRTUAL = `aggv_${SFX}`;
const TENANT_A = '00000000-0000-0000-0000-000000000001';
const B = { id: crypto.randomUUID(), slug: `aggb-${SFX}` };
const OWNER = `harness-aggregate-${SFX}`;

type Rec = Record<string, unknown>;
type Agg = {
  data: { group: Rec; values: Rec }[];
  truncated: boolean;
  detail?: string;
  code?: string;
};

const field = (name: string, type: string, extra: Rec = {}) => ({
  name,
  type,
  required: false,
  unique: false,
  indexed: false,
  ...extra,
});

d('data API aggregates under the read rules (ADR 0050)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let member = '';
  let ruleId = '';
  let publicRuleId = '';

  // `ANON` sends no credential: the `public` role.
  const ANON = '';
  const get = (path: string, cookie: string) =>
    app.request(path, { headers: cookie ? { cookie } : {} });
  const agg = async (qs: string, cookie = member) => {
    const res = await get(`/api/data/${COLL}/aggregate?${qs}`, cookie);
    return { status: res.status, body: (await res.json()) as Agg };
  };
  const total = async (qs: string, cookie = member) => {
    const res = await get(`/api/data/${COLL}?${qs}`, cookie);
    expect(res.status).toBe(200);
    return ((await res.json()) as { pagination: { total: number } }).pagination.total;
  };
  const json = (o: unknown) => `filter=${encodeURIComponent(JSON.stringify(o))}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [
        field('title', 'text'),
        field('status', 'text'),
        field('amount', 'decimal'),
        field('qty', 'integer'),
        field('day', 'date'),
        field('at', 'datetime'),
        field('cost', 'number'),
        field('meta', 'json'),
        field('note', 'text', { encrypted: true }),
        field('token', 'secret'),
      ],
    } as never);
    const rows = [
      ['a', 'open', 10.5, 1, '2026-01-05', '2026-01-05T10:00:00Z', 100],
      ['b', 'open', 20.25, 2, '2026-01-20', '2026-01-31T23:30:00Z', 200],
      ['c', 'closed', 5, 3, '2026-02-10', '2026-02-10T00:00:00Z', 300],
      ['d', 'draft', 1000, 4, '2026-03-01', '2026-03-01T00:00:00Z', 400],
    ] as const;
    // Written before the row rule: since ADR 0037 it binds a god's writes too.
    for (const [title, status, amount, qty, day, at, cost] of rows) {
      const res = await app.request(`/api/data/${COLL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: god },
        body: JSON.stringify({
          title,
          status,
          amount,
          qty,
          day,
          at,
          cost,
          meta: { k: 1 },
          note: `n-${title}`,
          token: `t-${title}`,
        }),
      });
      expect(res.status).toBe(201);
    }
    // Another firm's row, which no reader in tenant A may count.
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${B.id}::uuid, ${B.slug}, 'aggb', 'active')`.execute(db);
    await asTenant(db, B.id, (trx) =>
      sql`INSERT INTO ${sql.table(TABLE)} (title, status, amount, qty, tenant_id)
          VALUES ('other-firm', 'open', 99999, 9, ${B.id}::uuid)`.execute(trx),
    );

    const rule = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        collection: COLL,
        role: '*',
        filter_field: 'status',
        filter_op: 'neq',
        filter_value_source: 'static:draft',
      }),
    });
    expect(rule.status).toBe(201);
    ruleId = ((await rule.json()) as { policy: { id: string } }).policy.id;
    await invalidateRlsCache(COLL);

    await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: COLL,
        column_name: 'cost',
        role: 'member',
        can_read: false,
        can_write: false,
      })
      .execute();
    await invalidateColumnPermCache(COLL);
    member = (
      await createMemberSession(app, db, { grants: [{ collection: COLL, actions: ['read'] }] })
    ).cookie;
  }, 60_000);

  afterEach(() => {
    queryAlterRegistry.unregisterAll(OWNER);
    entityAccessRegistry.scope(OWNER).unregisterAll();
  });

  afterAll(async () => {
    if (!db) return;
    const e = await getEnforcer();
    await e.removePolicy('public', TENANT_A, COLL, 'read').catch(() => {});
    await invalidateAllPermissionCaches().catch(() => {});
    for (const id of [ruleId, publicRuleId].filter(Boolean)) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${id}::uuid`.execute(db).catch(() => {});
    }
    await invalidateRlsCache(COLL).catch(() => {});
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLL}`
      .execute(db)
      .catch(() => {});
    await asTenant(db, B.id, (trx) =>
      sql`DELETE FROM ${sql.table(TABLE)} WHERE tenant_id = ${B.id}::uuid`.execute(trx),
    ).catch(() => {});
    await dropTestCollection(db, COLL).catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', VIRTUAL)
      .execute()
      .catch(() => {});
    DDLManager.invalidateCache(VIRTUAL);
    await sql`DELETE FROM zv_tenants WHERE id = ${B.id}::uuid`.execute(db).catch(() => {});
  });

  it('counts and sums what the list reads: row rule and other tenant out, count = total', async () => {
    const { status, body } = await agg('fn=count,sum:amount,avg:qty,min:day,max:at');
    expect(status).toBe(200);
    expect(body.truncated).toBe(false);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.group).toEqual({});
    const v = body.data[0]!.values;
    // `draft` is the row rule's, `other-firm` tenant B's.
    expect(v.count).toBe(3);
    expect(v.count).toBe(await total(''));
    // `decimal` served as the list serves it: a number.
    expect(v['sum:amount']).toBe(35.75);
    expect(v['avg:qty']).toBe(2);
    expect(String(v['min:day'])).toContain('2026-01-05');
    expect(new Date(String(v['max:at'])).toISOString()).toBe('2026-02-10T00:00:00.000Z');

    for (const qs of [json({ status: 'open' }), 'status[eq]=closed', 'search=a', '']) {
      const r = await agg(`fn=count&${qs}`);
      expect(r.status).toBe(200);
      expect(r.body.data[0]!.values.count).toBe(await total(qs));
    }
  });

  it('groups, buckets and caps groups at limit', async () => {
    const byStatus = await agg('fn=count,sum:amount&group_by=status');
    expect(byStatus.status).toBe(200);
    expect(byStatus.body.data).toEqual([
      { group: { status: 'closed' }, values: { count: 1, 'sum:amount': 5 } },
      { group: { status: 'open' }, values: { count: 2, 'sum:amount': 30.75 } },
    ]);

    const months = await agg('fn=count&group_by=at&bucket=at:month');
    expect(months.status).toBe(200);
    expect(
      months.body.data.map((g) => [new Date(String(g.group.at)).toISOString(), g.values.count]),
    ).toEqual([
      ['2026-01-01T00:00:00.000Z', 2],
      ['2026-02-01T00:00:00.000Z', 1],
    ]);
    const days = await agg('fn=count&group_by=day,status&bucket=day:month');
    expect(days.body.data.map((g) => g.values.count)).toEqual([2, 1]);

    const capped = await agg('fn=count&group_by=title&limit=2');
    expect(capped.body.data.map((g) => g.group.title)).toEqual(['a', 'b']);
    expect(capped.body.truncated).toBe(true);
  });

  it('a query alter applies before the aggregation', async () => {
    queryAlterRegistry.registerAs(OWNER, TABLE, (qb: { where: (...a: unknown[]) => unknown }) =>
      qb.where('qty', '<', 3),
    );
    const { body } = await agg('fn=count,sum:qty');
    expect(body.data[0]!.values).toEqual({ count: 2, 'sum:qty': 3 });
    expect(await total('')).toBe(2);
  });

  it('a hidden column answers exactly as a column that does not exist', async () => {
    const shapes = [
      (f: string) => `fn=sum:${f}`,
      (f: string) => `fn=count:${f}`,
      (f: string) => `fn=max:${f}`,
      (f: string) => `fn=count&group_by=${f}`,
      (f: string) => `fn=count&group_by=${f}&bucket=${f}:day`,
      (f: string) => `fn=count&${json({ [f]: { gt: 1 } })}`,
      (f: string) => `fn=count&${f}[gt]=1`,
    ];
    for (const qs of shapes) {
      const hidden = await agg(qs('cost'));
      const unknown = await agg(qs('nosuchcol'));
      expect([qs('cost'), hidden.status]).toEqual([qs('cost'), 400]);
      expect(
        JSON.stringify({ ...hidden.body, traceId: 0, instance: 0 }).replaceAll('cost', 'F'),
      ).toBe(
        JSON.stringify({ ...unknown.body, traceId: 0, instance: 0 }).replaceAll('nosuchcol', 'F'),
      );
    }
  });

  it('a masked column: the member is refused, a reader of the whole column sums it', async () => {
    const view = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_views WHERE viewname = ${`zvv_${COLL}`}`.execute(db);
    expect(view.rows[0]!.n).toBe(1);
    expect((await agg('fn=sum:cost')).status).toBe(400);
    const whole = await agg('fn=sum:cost&status[neq]=draft', god);
    expect(whole.status).toBe(200);
    // God reads every firm; tenant B's row has no cost.
    expect(whole.body.data[0]!.values['sum:cost']).toBe(600);
  });

  it('sealed, secret and encrypted fields are unknown to every caller, god included', async () => {
    for (const f of ['note', 'token', 'search_vector', 'tenant_id']) {
      for (const qs of [
        `fn=count:${f}`,
        `fn=count&group_by=${f}`,
        `fn=count&${json({ [f]: 'x' })}`,
      ]) {
        const res = await agg(qs, god);
        expect([qs, res.status]).toEqual([qs, 400]);
        expect(res.body.detail).toMatch(/^Unknown (filter )?field: /);
      }
    }
  });

  it('refuses unknown functions, units, type mismatches and too many of either: 400', async () => {
    for (const qs of [
      'fn=median:amount',
      'fn=sum',
      'fn=count:',
      'fn=sum:amount;drop',
      'fn=count,count',
      `fn=${Array.from({ length: 9 }, (_, i) => (i ? `count:${['title', 'status', 'amount', 'qty', 'day', 'at', 'meta', 'id'][i - 1]}` : 'count')).join(',')}`,
      'fn=count&group_by=title,status,qty,day',
      'fn=count&group_by=day&bucket=day:hour',
      'fn=count&group_by=day&bucket=day',
      'fn=count&bucket=day:month',
      'fn=count&group_by=title&bucket=title:month',
      'fn=sum:title',
      'fn=avg:day',
      'fn=min:meta',
      'fn=count&group_by=meta',
      'fn=count&limit=501',
      'fn=count&filter=nope',
      `fn=count&as_of=${encodeURIComponent(new Date().toISOString())}`,
      'group_by=status',
    ]) {
      expect([qs, (await agg(qs)).status]).toEqual([qs, 400]);
    }
  });

  it('a collection with an entity-access check answers 403 aggregate_unavailable', async () => {
    entityAccessRegistry.scope(OWNER).register({ table: TABLE, check: () => 'allow' });
    const { status, body } = await agg('fn=count');
    expect(status).toBe(403);
    expect(body.code).toBe('aggregate_unavailable');
    expect((await get(`/api/data/${COLL}`, member)).status).toBe(200);
  });

  it('a virtual collection answers 400', async () => {
    await db
      .insertInto('zvd_collections')
      .values({
        name: VIRTUAL,
        display_name: VIRTUAL,
        icon: 'Table',
        route_group: 'private',
        is_permissioned: true,
        is_managed: true,
        is_system: false,
        schema_locked: false,
        sort: 99,
        singular_name: VIRTUAL,
        source_type: 'virtual',
        virtual_config: toJsonb({
          source_url: 'https://example.com/aggregate',
          auth_type: 'none',
          list_path: '$.items',
          id_field: 'id',
        }),
        fields: toJsonb([field('title', 'text')]),
      })
      .execute();
    DDLManager.invalidateCache(VIRTUAL);
    const res = await get(`/api/data/${VIRTUAL}/aggregate?fn=count`, god);
    expect(res.status).toBe(400);
  });

  it('the public role aggregates under its grant and its row rule, and nothing without', async () => {
    expect((await agg('fn=count', ANON)).status).toBe(403);
    const e = await getEnforcer();
    await e.addPolicy('public', TENANT_A, COLL, 'read');
    await invalidateAllPermissionCaches();
    const rule = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        collection: COLL,
        role: 'public',
        filter_field: 'status',
        filter_op: 'eq',
        filter_value_source: 'static:open',
      }),
    });
    expect(rule.status).toBe(201);
    publicRuleId = ((await rule.json()) as { policy: { id: string } }).policy.id;
    await invalidateRlsCache(COLL);
    const { status, body } = await agg('fn=count,sum:amount&group_by=at&bucket=at:year', ANON);
    expect(status).toBe(200);
    expect(body.data.map((g) => g.values)).toEqual([{ count: 2, 'sum:amount': 30.75 }]);
    expect(body.data[0]!.values.count).toBe(await total('', ANON));
  });

  it('a statement over the ceiling answers 422 and leaves the request usable', async () => {
    queryAlterRegistry.registerAs(OWNER, TABLE, (qb: { where: (e: unknown) => unknown }) =>
      qb.where(sql`pg_sleep(6) IS NOT NULL`),
    );
    const slow = await agg('fn=count');
    expect(slow.status).toBe(422);
    expect(slow.body.code).toBe('aggregate_too_costly');
    queryAlterRegistry.unregisterAll(OWNER);
    expect((await agg('fn=count')).status).toBe(200);
  }, 20_000);

  it('the ceiling is a savepoint: the timeout is put back, after success and after a timeout', async () => {
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = '7s'`.execute(trx);
      const setting = async () =>
        (await sql<{ t: string }>`SELECT current_setting('statement_timeout') AS t`.execute(trx))
          .rows[0]!.t;
      const ok = await underCeiling(trx, async () => setting());
      expect(ok).toBe('5s');
      expect(await setting()).toBe('7s');
      const slow = await underCeiling(trx, () => sql`SELECT pg_sleep(6)`.execute(trx));
      expect(typeof slow).toBe('symbol');
      expect(await setting()).toBe('7s');
    });
  }, 20_000);
});
