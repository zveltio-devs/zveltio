/**
 * `?as_of=` used to read the whole history of a collection to return one page:
 * `SELECT DISTINCT ON (record_id) … FROM zv_revisions` with no LIMIT, every
 * snapshot parsed in-process, filtered, and only then sliced. Measured on
 * 200 000 records with two revisions each: 336 ms, of which the row-policy
 * filter was 2,2 ms — the reading was the cost, not the filtering. The same
 * page asked of the database: 2 ms.
 *
 * Moving the row policies into that query is the part that can leak, so it is
 * pinned here before anything else. The trap:
 *
 *   in memory:  r['code'] === '5'                  → 5 !== '5'  → hidden
 *   naive SQL:  data->>'code' = '5'                → '5' = '5'  → SHOWN
 *   correct:    data->'code' = to_jsonb('5'::text) → hidden
 *
 * `->>` renders any JSON scalar as text, so a numeric snapshot value would
 * satisfy a policy written against a string. The error is in the bad direction:
 * it shows a row the policy hides. Every operator is planted on that case, not
 * just `eq`.
 *
 * Two more things this suite learned the hard way, both of which made an earlier
 * version of it pass while the feature was broken:
 *
 *   - `data -> $1` with an untyped parameter resolves to `jsonb -> integer`,
 *     the array-element operator, which returns NULL for every object. The page
 *     came back empty and the "these rows stay hidden" assertions were all
 *     satisfied. Hence `$1::text`.
 *   - `zv_revisions.data` is jsonb, but rows written by the engine hold a jsonb
 *     STRING containing serialised JSON, not the object. A key lookup against
 *     that finds nothing, silently.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateRlsCache, rlsJsonConditions } from '../../lib/tenancy/index.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLLECTION = `httsql_${STAMP}`;

async function memberSession(app: Hono, db: Database) {
  const email = `harness-ttsql-${STAMP}@test.local`;
  const password = 'MemberUser123!';
  const signUp = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Member' }),
  });
  const userId = ((await signUp.json()) as { user?: { id: string } }).user?.id ?? '';
  await sql`UPDATE "user" SET role = 'member' WHERE id = ${userId}`.execute(db);
  const enforcer = await getEnforcer();
  await enforcer.addPolicy(userId, '*', COLLECTION, 'read');
  await invalidateUserPermCache(userId);
  const signIn = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (signIn.headers.get('set-cookie') ?? '')
    .split(',')
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
  return { cookie, userId };
}

d('time travel pages in SQL (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let policyId = '';
  let asOf = '';

  /**
   * A rule the save route now refuses, written straight into the table.
   *
   * `nosuchfield` names a column that does not exist, which `createRlsPolicy`
   * rejects since the audit — one rule must not mean three things. Installs that
   * predate the refusal can still hold such a row, so what the predicate does
   * with it stays pinned; only the door is closed.
   */
  const setPolicyDirect = async (field: string, op: string, source: string) => {
    if (policyId) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${policyId}::uuid`.execute(db);
      policyId = '';
    }
    const row = await sql<{ id: string }>`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${COLLECTION}, '*', ${field}, ${op}, ${source}, true)
      RETURNING id
    `.execute(db);
    policyId = row.rows[0]!.id;
    await invalidateRlsCache(COLLECTION);
  };

  const setPolicy = async (field: string, op: string, source: string) => {
    if (policyId) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${policyId}::uuid`.execute(db);
      policyId = '';
    }
    const res = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection: COLLECTION,
        role: '*',
        filter_field: field,
        filter_op: op,
        filter_value_source: source,
        description: `${field} ${op}`,
      }),
    });
    expect(res.status).toBe(201);
    policyId = ((await res.json()) as { policy: { id: string } }).policy.id;
    await invalidateRlsCache(COLLECTION);
  };

  const clearPolicy = async () => {
    if (!policyId) return;
    await sql`DELETE FROM zvd_rls_policies WHERE id = ${policyId}::uuid`.execute(db);
    policyId = '';
    await invalidateRlsCache(COLLECTION);
  };

  /** Labels a caller sees, live and as of `asOf`, sorted. */
  const seen = async (cookie: string, timeTravel: boolean, extra = '') => {
    const q = `${timeTravel ? `?as_of=${encodeURIComponent(asOf)}` : '?'}${extra ? `&${extra}` : ''}`;
    const res = await app.request(`/api/data/${COLLECTION}${q}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records?: Array<{ label: string }>;
      pagination?: { total: number };
    };
    return {
      labels: (body.records ?? []).map((r) => r.label).sort(),
      total: body.pagination?.total ?? -1,
    };
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
        { name: 'bucket', type: 'text', required: false, unique: false, indexed: false },
        { name: 'code', type: 'integer', required: false, unique: false, indexed: false },
      ],
    } as never);

    // `bucket` is text and `code` is an integer, but BOTH land in the snapshot
    // as JSON strings: the revision writer renders scalars as text. Measured,
    // not assumed — the first version of this suite asserted the opposite and
    // passed anyway, for an unrelated reason. The genuine JSON number needed to
    // test the translation is written directly, further down.
    const rows = [
      { label: 'a1', bucket: 'alpha', code: 5 },
      { label: 'a2', bucket: 'alpha', code: 7 },
      { label: 'b1', bucket: 'beta', code: 5 },
      { label: 'b2', bucket: 'beta', code: 7 },
    ];
    for (const r of rows) {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: godCookie },
        body: JSON.stringify(r),
      });
      expect(res.status).toBe(201);
    }
    asOf = new Date(Date.now() + 60_000).toISOString();
    ({ cookie: memberCookie } = await memberSession(app, db));
  });

  afterAll(async () => {
    if (!db) return;
    await clearPolicy().catch(() => {});
    await db
      .deleteFrom('zv_revisions')
      .where('collection', '=', COLLECTION)
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

  describe('a policy on a text field means the same thing on both paths', () => {
    it('eq', async () => {
      await setPolicy('bucket', 'eq', 'static:alpha');
      const live = await seen(memberCookie, false);
      const past = await seen(memberCookie, true);
      expect(past.labels).toEqual(live.labels);
      expect(past.labels).toEqual(['a1', 'a2']);
      expect(past.total).toBe(2);
    });

    it('neq', async () => {
      await setPolicy('bucket', 'neq', 'static:alpha');
      expect((await seen(memberCookie, true)).labels).toEqual(
        (await seen(memberCookie, false)).labels,
      );
      expect((await seen(memberCookie, true)).labels).toEqual(['b1', 'b2']);
    });

    it('in', async () => {
      await setPolicy('bucket', 'in', 'static:alpha,beta');
      expect((await seen(memberCookie, true)).labels).toEqual(['a1', 'a2', 'b1', 'b2']);
    });

    it('not_in', async () => {
      await setPolicy('bucket', 'not_in', 'static:alpha');
      expect((await seen(memberCookie, true)).labels).toEqual(
        (await seen(memberCookie, false)).labels,
      );
      expect((await seen(memberCookie, true)).labels).toEqual(['b1', 'b2']);
    });
  });

  describe('the number that is not its own text', () => {
    // A policy value is always a string — the four sources are user_id,
    // user_email, user_role and static:VAL. Against a JSON number, `===` says
    // no, so the SQL must say no too. `->>` would say yes.
    //
    // The engine's own revision writer does not currently produce JSON numbers:
    // an `integer` collection field arrives in the snapshot as the string "5"
    // (scalars are rendered as text on the way in, and the whole document is
    // then stored double-encoded). Both facts are pinned below — the second
    // because it is what callers see today, the first because the writer is not
    // the only thing that can put a row in `zv_revisions`, and a translation
    // that is only correct for the shapes we happen to write is not correct.
    const NUMERIC = `numeric-${STAMP}`;

    beforeAll(async () => {
      const tenant = (await sql<{ id: string }>`SELECT id FROM zv_tenants LIMIT 1`.execute(db))
        .rows[0]!.id;
      // A genuine JSON number, written directly.
      await sql`
        INSERT INTO zv_revisions (collection, record_id, action, data, created_at, tenant_id)
        VALUES (${COLLECTION}, ${NUMERIC}, 'create',
                jsonb_build_object('label', 'num', 'bucket', 'gamma', 'code', 5),
                now(), ${tenant}::uuid)
      `.execute(db);
    });

    afterAll(async () => {
      await sql`DELETE FROM zv_revisions WHERE record_id = ${NUMERIC}`.execute(db).catch(() => {});
    });

    it('eq hides a row whose value is the NUMBER 5 when the policy says "5"', async () => {
      await setPolicy('code', 'eq', 'static:5');
      const labels = (await seen(memberCookie, true)).labels;
      // a1 and b1 carry the STRING "5" — the writer renders scalars as text —
      // so they match. `num` carries the number and must not.
      expect(labels).toEqual(['a1', 'b1']);
      expect(labels).not.toContain('num');
    });

    it('in hides it as well', async () => {
      await setPolicy('code', 'in', 'static:5,7');
      expect((await seen(memberCookie, true)).labels).not.toContain('num');
    });

    it('neq keeps it, because a number never equals the text', async () => {
      await setPolicy('code', 'neq', 'static:5');
      expect((await seen(memberCookie, true)).labels).toContain('num');
    });

    it('not_in keeps it too', async () => {
      await setPolicy('code', 'not_in', 'static:5');
      expect((await seen(memberCookie, true)).labels).toContain('num');
    });

    it('keeps a row that has no such key at all, on the negative operators', async () => {
      // A missing key is `undefined` in memory and SQL NULL here. `<>` and
      // `NOT IN` both yield NULL for it, and a WHERE drops what it cannot
      // confirm — so the two negative operators say so explicitly.
      await setPolicyDirect('nosuchfield', 'neq', 'static:whatever');
      expect((await seen(memberCookie, true)).labels).toHaveLength(5);
      await setPolicyDirect('nosuchfield', 'not_in', 'static:whatever');
      expect((await seen(memberCookie, true)).labels).toHaveLength(5);
    });

    it('hides everything on the positive operators when the key is missing', async () => {
      await setPolicyDirect('nosuchfield', 'eq', 'static:whatever');
      expect((await seen(memberCookie, true)).labels).toEqual([]);
      await setPolicyDirect('nosuchfield', 'in', 'static:whatever');
      expect((await seen(memberCookie, true)).labels).toEqual([]);
    });
  });

  describe('the translation itself', () => {
    it('refuses an operator it cannot express, like both older appliers', async () => {
      expect(() =>
        rlsJsonConditions([{ field: 'x', condition: { op: 'gt' as never, value: '1' } }]),
      ).toThrow(/cannot apply/);
    });

    it('produces nothing at all when there is no policy', () => {
      expect(rlsJsonConditions([])).toHaveLength(0);
    });
  });

  describe('pagination', () => {
    it('slices the same way it always did', async () => {
      await clearPolicy();
      const first = await seen(godCookie, true, 'limit=2&page=1');
      const second = await seen(godCookie, true, 'limit=2&page=2');
      expect(first.labels).toHaveLength(2);
      expect(second.labels).toHaveLength(2);
      expect(first.total).toBe(4);
      expect(second.total).toBe(4);
      // Disjoint, and together the whole set.
      expect([...first.labels, ...second.labels].sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
    });

    it('asks the database for one page, not for the collection', async () => {
      // Criterion 1: proved by rows read, not by a stopwatch. The bounded query
      // must return exactly the page even though the history holds far more.
      const tenant = (await sql<{ id: string }>`SELECT id FROM zv_tenants LIMIT 1`.execute(db))
        .rows[0]!.id;
      const bounded = await sql<{ record_id: string }>`
        WITH latest AS (
          SELECT DISTINCT ON (record_id) record_id, action, data
            FROM zv_revisions
           WHERE collection = ${COLLECTION} AND tenant_id = ${tenant}::uuid
             AND created_at <= ${asOf}
           ORDER BY record_id, created_at DESC
        )
        SELECT record_id FROM latest WHERE action <> 'delete'
         ORDER BY record_id LIMIT 2 OFFSET 0
      `.execute(db);
      expect(bounded.rows).toHaveLength(2);
    });
  });
});
