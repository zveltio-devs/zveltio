/**
 * Electric shapes through the engine's read gate.
 *
 * Electric reads Postgres as a role that bypasses RLS, so the only thing between
 * a client and every row of every tenant is the shape the engine builds. Two
 * tenants, a member restricted by a row rule and a hidden column, and god.
 *
 * The refusals run on every harness run (they answer before Electric is asked).
 * The stream itself needs a real Electric 1.x on the SAME database:
 *
 *   docker run --network host -e DATABASE_URL=$TEST_DATABASE_URL \
 *     -e ELECTRIC_SECRET=s -e ELECTRIC_PORT=5133 electricsql/electric
 *   ELECTRIC_TEST_URL=http://127.0.0.1:5133 ELECTRIC_TEST_SECRET=s bun test …
 *
 * and is skipped without ELECTRIC_TEST_URL.
 *
 * Before this route, Electric 0.12 streamed every published table to any
 * signed-in client (#969); PR #974 refused it outright.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createOfflineProvider } from '@zveltio/sdk/offline';
import { DDLManager } from '../../lib/data/index.js';
import { createRlsPolicy, deleteRlsPolicy, putColumnPermission } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const live = harnessAvailable() && process.env.ELECTRIC_TEST_URL ? describe : describe.skip;
const TAG = `${Date.now()}`;
const COLL = `helectric_${TAG}`;
const A = { id: crypto.randomUUID(), slug: `elec-a-${TAG}` };
const B = { id: crypto.randomUUID(), slug: `elec-b-${TAG}` };
/** Every hidden value carries this, so one `includes` proves it never arrived. */
const HIDE = `HIDDEN-${TAG}`;
/** A password field: its hash is never an API output, for anyone. */
const PW = { name: 'pw', type: 'password' };

type Message = {
  value?: Record<string, unknown>;
  headers: { operation?: string; control?: string };
};

let app: Hono;
let db: Database;
let god = '';
let member = { cookie: '', userId: '' };
let ruleId = '';
const env = { url: process.env.ELECTRIC_URL, secret: process.env.ELECTRIC_SECRET };

const asMember = (slug = A.slug) => ({ cookie: member.cookie, 'x-tenant-slug': slug });
const asGod = () => ({ cookie: god, 'x-tenant-slug': A.slug });

async function insert(tenant: { id: string }, title: string, owner: string, secret: string) {
  await sql`INSERT INTO ${sql.id(`zvd_${COLL}`)} (tenant_id, title, owner, secret)
            VALUES (${tenant.id}::uuid, ${title}, ${owner}, ${secret})`.execute(db);
}

async function shape(headers: Record<string, string>, params: Record<string, string>) {
  const qs = new URLSearchParams({ collection: COLL, ...params });
  const res = await app.request(`/api/electric/v1/shape?${qs}`, { headers });
  const text = await res.text();
  return { res, text, messages: (res.ok ? JSON.parse(text) : []) as Message[] };
}

/** Initial sync to up-to-date: the rows, and where to continue from. */
async function sync(headers: Record<string, string>) {
  const rows: Record<string, unknown>[] = [];
  let params: Record<string, string> = { offset: '-1' };
  let raw = '';
  for (let i = 0; i < 20; i++) {
    const { res, text, messages } = await shape(headers, params);
    expect(res.status).toBe(200);
    raw += text;
    for (const m of messages) if (m.value) rows.push(m.value);
    params = {
      offset: res.headers.get('electric-offset')!,
      handle: res.headers.get('electric-handle')!,
    };
    if (messages.some((m) => m.headers.control === 'up-to-date')) {
      return { rows, raw, params, schema: res.headers.get('electric-schema') ?? '' };
    }
  }
  throw new Error('never up to date');
}

d('electric shapes', () => {
  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    process.env.ELECTRIC_URL = process.env.ELECTRIC_TEST_URL ?? 'http://127.0.0.1:9';
    process.env.ELECTRIC_SECRET = process.env.ELECTRIC_TEST_SECRET ?? 'harness-secret';
    for (const t of [A, B]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${t.id}::uuid, ${t.slug}, 'electric', 'active')`.execute(db);
    }
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [...['title', 'owner', 'secret'].map((name) => ({ name, type: 'text' })), PW].map(
        (f) => ({
          ...f,
          required: false,
          unique: false,
          indexed: false,
        }),
      ),
    } as never);
    god = await createGodSession(app, db);
    member = await createMemberSession(app, db, {
      grants: [{ collection: COLL, actions: ['read'] }],
    });
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${A.id}::uuid, ${member.userId}, 'member')`.execute(db);
    ruleId = (
      await createRlsPolicy({
        collection: COLL,
        role: '*',
        filter_field: 'owner',
        filter_op: 'eq',
        filter_value_source: 'user_id',
      })
    ).id;
    await putColumnPermission(db, {
      collection_name: COLL,
      column_name: 'secret',
      role: 'member',
      can_read: false,
      can_write: false,
    });
    await insert(A, 'a-mine', member.userId, `${HIDE}-col-a`);
    await insert(A, `${HIDE}-a-other`, 'someone-else', `${HIDE}-col-a2`);
    await insert(B, `${HIDE}-b-mine`, member.userId, `${HIDE}-col-b`);
    // REST never returns a password field (its type serializes to nothing).
    await sql`UPDATE ${sql.id(`zvd_${COLL}`)} SET pw = ${`$argon2id$v=19$${HIDE}-pw`}`.execute(db);
  }, 120_000);

  afterAll(async () => {
    for (const [k, v] of [
      ['ELECTRIC_URL', env.url],
      ['ELECTRIC_SECRET', env.secret],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (!db) return;
    if (ruleId) await deleteRlsPolicy(ruleId).catch(() => {});
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLL}`
      .execute(db)
      .catch(() => {});
    await dropTestCollection(db, COLL).catch(() => {});
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id IN (${A.id}::uuid, ${B.id}::uuid)`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id IN (${A.id}::uuid, ${B.id}::uuid)`
      .execute(db)
      .catch(() => {});
  });

  it('the member reads one row, without the hidden column, on REST (the setup is real)', async () => {
    const res = await app.request(`/api/data/${COLL}`, { headers: asMember() });
    const body = (await res.json()) as { records: Record<string, unknown>[] };
    expect(body.records.map((r) => r.title)).toEqual(['a-mine']);
    expect(JSON.stringify(body)).not.toContain(HIDE);
  });

  it('a client cannot name the table, where, columns, params, secret or a subset', async () => {
    for (const forged of <Record<string, string>[]>[
      { table: 'zv_api_keys' },
      { where: 'true' },
      { columns: 'id,secret' },
      { 'params[1]': B.id },
      { secret: 'guess' },
      { api_secret: 'guess' },
      { subset__where: 'secret LIKE $1' },
    ]) {
      const { res, text } = await shape(asMember(), { offset: '-1', ...forged });
      expect({ forged, status: res.status }).toEqual({ forged, status: 400 });
      expect(text).toContain('electric.param_refused');
    }
  });

  it('401 anonymous, 403 without a read grant, 403 in a tenant the member is not in', async () => {
    expect((await shape({}, { offset: '-1' })).res.status).toBe(401);
    const stranger = await createMemberSession(app, db);
    expect((await shape({ cookie: stranger.cookie }, { offset: '-1' })).res.status).toBe(403);
    expect((await shape(asMember(B.slug), { offset: '-1' })).res.status).toBe(403);
  });

  it('503 when Electric is not configured', async () => {
    const url = process.env.ELECTRIC_URL;
    delete process.env.ELECTRIC_URL;
    try {
      expect((await shape(asMember(), { offset: '-1' })).res.status).toBe(503);
    } finally {
      process.env.ELECTRIC_URL = url;
    }
  });

  live('against a real Electric', () => {
    it("the member's shape is their tenant's allowed rows and allowed columns", async () => {
      const { rows, raw, schema } = await sync(asMember());
      expect(rows.map((r) => r.title)).toEqual(['a-mine']);
      expect(Object.keys(rows[0]!).sort()).not.toContain('secret');
      expect(schema).not.toContain('"secret"');
      expect(raw).not.toContain(HIDE);
    });

    it('live changes the member may not see never reach them; one they may, does', async () => {
      const { params } = await sync(asMember());
      const poll = shape(asMember(), { ...params, live: 'true' });
      await Bun.sleep(300);
      await db.transaction().execute(async (trx) => {
        const t = `zvd_${COLL}`;
        await sql`INSERT INTO ${sql.id(t)} (tenant_id, title, owner, secret) VALUES
                    (${A.id}::uuid, ${`${HIDE}-live-a`}, 'someone-else', 'x'),
                    (${B.id}::uuid, ${`${HIDE}-live-b`}, ${member.userId}, 'x'),
                    (${A.id}::uuid, 'live-mine', ${member.userId}, ${`${HIDE}-live-col`})`.execute(
          trx,
        );
        // A row they can see changes only in the hidden column.
        await sql`UPDATE ${sql.id(t)} SET secret = ${`${HIDE}-updated`} WHERE title = 'a-mine'`.execute(
          trx,
        );
      });
      const { res, text, messages } = await poll;
      expect(res.status).toBe(200);
      expect(text).not.toContain(HIDE);
      expect(messages.filter((m) => m.value?.title).map((m) => m.value!.title)).toEqual([
        'live-mine',
      ]);
    });

    it('the SDK provider syncs the same shape and follows it live', async () => {
      const p = await createOfflineProvider({
        provider: 'electric',
        engineUrl: 'http://engine.local',
        headers: asMember(),
        fetch: ((input: string | URL, init?: RequestInit) =>
          app.request(String(input), init)) as typeof fetch,
      });
      const seen: Array<Array<Record<string, unknown>>> = [];
      const off = p.subscribe(COLL, (rows) => seen.push(rows as Array<Record<string, unknown>>));
      try {
        const titles = () => (seen.at(-1) ?? []).map((r) => r.title).sort();
        for (let i = 0; i < 100 && !titles().includes('a-mine'); i++) await Bun.sleep(20);
        await Bun.sleep(300);
        await insert(A, 'sdk-mine', member.userId, `${HIDE}-sdk`);
        await insert(B, `${HIDE}-sdk-b`, member.userId, 'x');
        for (let i = 0; i < 100 && !titles().includes('sdk-mine'); i++) await Bun.sleep(20);
        expect(titles()).toContain('a-mine');
        expect(titles()).toContain('sdk-mine');
        expect(JSON.stringify(seen)).not.toContain(HIDE);
      } finally {
        off();
        await p.close();
      }
    });

    it("another caller's handle cannot widen the shape", async () => {
      const wide = await sync(asGod());
      expect(wide.raw).toContain(HIDE);
      const { res, text } = await shape(asMember(), wide.params);
      expect(res.status).toBe(409);
      expect(text).toContain('electric.must_refetch');
      expect(text).not.toContain(HIDE);
    });

    it('god syncs what god reads on REST: every tenant, every column', async () => {
      const rest = (await (
        await app.request(`/api/data/${COLL}?limit=100`, { headers: asGod() })
      ).json()) as { records: Record<string, unknown>[] };
      const { rows } = await sync(asGod());
      const titles = (rs: Record<string, unknown>[]) => rs.map((r) => r.title).sort();
      expect(titles(rows)).toEqual(titles(rest.records));
      expect(titles(rows)).toContain(`${HIDE}-b-mine`);
      // A password field is never an API output (REST sends `pw: null` only
      // when there is no hash), so not even god's shape selects it.
      const restKeys = Object.keys(rest.records[0]!).filter((k) => k !== PW.name);
      expect(Object.keys(rows[0]!).sort()).toEqual(restKeys.sort());
      expect(rows.some((r) => PW.name in r)).toBe(false);
    });
  });
});
