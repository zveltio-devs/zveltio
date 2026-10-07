/**
 * One role vocabulary for the read gate: REST and both realtime doors.
 *
 * The realtime doors handed `readScope` the caller with `role` already resolved
 * (`resolveUserRole`); REST handed it the session user, where better-auth
 * leaves `role` undefined. Row rules stopped reading `user.role` in #783, but
 * the same object still went to the extension gates, so an entity-access or
 * query-alter rule keyed on the role saw `member` on a socket and nothing on
 * `GET /api/data` — the same rule, two answers.
 *
 * The writes had the same split one layer down: PATCH, PUT and DELETE (single
 * and bulk) handed the extension gates the raw session user too.
 *
 * Two users, two directions: a self-registered member (role only in the
 * `"user".role` column, no Casbin `g` row) and a user who holds a role only as
 * a Casbin grouping. Each must see the same rows on REST, WS and SSE.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import { invalidateRlsCache } from '../../lib/tenancy/rls.js';
import { _sseConnectionsForTests, broadcastDataEvent } from '../../routes/realtime.js';
import { broadcastEvent, websocketHandler } from '../../routes/ws.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `rlsparity_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const CASBIN_ROLE = `parity_reviewer_${Date.now()}`;
const OWNER = 'harness-rls-parity';

type Who = { cookie: string; userId: string };

async function settle(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(10);
}

d('REST and realtime resolve the same roles for the read gate', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let member: Who;
  let reviewer: Who;
  const sockets: unknown[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const ids: Record<string, string> = {};
  // Every row as written, broadcast to the realtime doors as a write would.
  const written: Record<string, unknown>[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'owner', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    const grants = [
      { collection: COLLECTION, actions: ['read', 'list', 'create', 'update', 'delete'] },
    ];
    // Column role only: no `g` row (createMemberSession writes none).
    member = await createMemberSession(app, db, { grants });
    // Casbin role only: a `g` row the column does not name.
    reviewer = await createMemberSession(app, db, { grants });
    await (await getEnforcer()).addRoleForUser(reviewer.userId, CASBIN_ROLE, '*');
    await invalidateUserPermCache(reviewer.userId);

    await sql`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${COLLECTION}, 'member', 'owner', 'eq', 'user_id', true),
             (${COLLECTION}, ${CASBIN_ROLE}, 'title', 'eq', 'static:reviewed', true)
    `.execute(db);
    await invalidateRlsCache(COLLECTION);

    const rows: Array<[string, Record<string, string>]> = [
      ['memberOwn', { title: 'draft', owner: member.userId }],
      ['reviewerOwnReviewed', { title: 'reviewed', owner: reviewer.userId }],
      ['reviewerOwnDraft', { title: 'draft', owner: reviewer.userId }],
      ['otherReviewed', { title: 'reviewed', owner: 'someone-else' }],
    ];
    for (const [key, body] of rows) {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: god },
        body: JSON.stringify(body),
      });
      const row = (await res.json()) as Record<string, unknown> & { id: string };
      ids[key] = row.id;
      written.push(row);
      expect(ids[key]).toBeTruthy();
    }
  });

  afterEach(async () => {
    entityAccessRegistry.unregisterAll(OWNER);
    for (const ws of sockets.splice(0)) websocketHandler.close(ws as never);
    for (const r of readers.splice(0)) await r.cancel().catch(() => {});
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    await invalidateRlsCache(COLLECTION).catch(() => {});
    if (reviewer) {
      await (await getEnforcer()).deleteRoleForUser(reviewer.userId, CASBIN_ROLE, '*');
    }
    await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  async function rest(who: Who): Promise<string[]> {
    const res = await app.request(`/api/data/${COLLECTION}?limit=100`, {
      headers: { cookie: who.cookie },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { records: Array<{ id: string }> }).records
      .map((r) => r.id)
      .sort();
  }

  async function ws(who: Who): Promise<string[]> {
    const data = await wsUpgradeData(app, { cookie: who.cookie });
    const sent: string[] = [];
    const sock = {
      data: { ...data, id: `parity_${crypto.randomUUID()}`, tenantId: null },
      send: (p: string) => sent.push(p),
    };
    sockets.push(sock);
    websocketHandler.open(sock as never);
    await websocketHandler.message(
      sock as never,
      JSON.stringify({ type: 'subscribe', collections: [COLLECTION] }),
    );
    expect(sent.join('\n')).toContain(`"collections":["${COLLECTION}"]`);
    sent.length = 0;
    for (const row of written) broadcastEvent(COLLECTION, 'insert', row, null);
    await Bun.sleep(50);
    return sent
      .map((p) => JSON.parse(p) as { type?: string; data?: { id: string } })
      .flatMap((m) => (m.data?.id ? [m.data.id] : []))
      .sort();
  }

  async function sse(who: Who): Promise<string[]> {
    const res = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { cookie: who.cookie },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    readers.push(reader);
    await reader.read(); // `connected`
    const sub = [..._sseConnectionsForTests().get(who.userId)!].at(-1)!;
    const delivered: string[] = [];
    const realWrite = sub.stream.writeSSE.bind(sub.stream);
    sub.stream.writeSSE = (msg: { data: string; event?: string }) => {
      delivered.push(msg.data);
      return realWrite(msg);
    };
    for (const row of written) broadcastDataEvent(COLLECTION, 'insert', row, sub.tenantId ?? null);
    await settle(() => delivered.length >= 1);
    await Bun.sleep(30);
    return delivered
      .map((p) => JSON.parse(p) as { data?: { id: string }; record?: { id: string } })
      .flatMap((m) => {
        const id = m.data?.id ?? m.record?.id;
        return id ? [id] : [];
      })
      .sort();
  }

  it('the premise: both roles live in Casbin; the member holds `member` alone', async () => {
    const roles = await sql<{ id: string; role: string }>`
      SELECT id, role FROM "user" WHERE id IN (${member.userId}, ${reviewer.userId})
    `.execute(db);
    expect(roles.rows.every((r) => r.role === 'member')).toBe(true);
    const g = await sql<{ v0: string; v1: string }>`
      SELECT v0, v1 FROM zvd_permissions WHERE ptype = 'g'
        AND v0 IN (${member.userId}, ${reviewer.userId})
    `.execute(db);
    const held = (id: string) =>
      g.rows
        .filter((r) => r.v0 === id)
        .map((r) => r.v1)
        .sort();
    expect(held(member.userId)).toEqual(['member']);
    expect(held(reviewer.userId)).toEqual([CASBIN_ROLE, 'member'].sort());
  });

  it('a column-role member sees the same rows on REST, WS and SSE', async () => {
    const expected = [ids.memberOwn!].sort();
    expect(await rest(member)).toEqual(expected);
    expect(await ws(member)).toEqual(expected);
    expect(await sse(member)).toEqual(expected);
  });

  it('a Casbin-role holder sees the same rows on REST, WS and SSE', async () => {
    // member rule (owner) AND the Casbin-role rule (title) both apply.
    const expected = [ids.reviewerOwnReviewed!].sort();
    expect(await rest(reviewer)).toEqual(expected);
    expect(await ws(reviewer)).toEqual(expected);
    expect(await sse(reviewer)).toEqual(expected);
  });

  it('an entity-access rule sees the same user on REST, WS and SSE', async () => {
    // An extension rule keyed on the caller's role, as extensions read it.
    const seen: Array<string | undefined> = [];
    entityAccessRegistry.registerAs(OWNER, TABLE, (_r: unknown, u: { role?: string }) => {
      seen.push(u.role);
      return u.role === 'member' ? 'allow' : 'deny';
    });
    const expected = [ids.memberOwn!].sort();
    expect({ door: 'rest', ids: await rest(member) }).toEqual({ door: 'rest', ids: expected });
    expect({ door: 'ws', ids: await ws(member) }).toEqual({ door: 'ws', ids: expected });
    expect({ door: 'sse', ids: await sse(member) }).toEqual({ door: 'sse', ids: expected });
    expect(new Set(seen)).toEqual(new Set(['member']));
  });

  it('an entity-access rule sees the same role on REST update and delete', async () => {
    const seen: Array<string | undefined> = [];
    entityAccessRegistry.registerAs(OWNER, TABLE, (_r: unknown, u: { role?: string }) => {
      seen.push(u.role);
      return u.role === 'member' ? 'allow' : 'deny';
    });
    const own = async () => {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: god },
        body: JSON.stringify({ title: 'w', owner: member.userId }),
      });
      return ((await res.json()) as { id: string }).id;
    };
    const send = async (path: string, method: string, body?: unknown) => {
      const res = await app.request(`/api/data/${COLLECTION}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', cookie: member.cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        op: `${method} ${path ? path.replace(/\/[0-9a-f-]{36}$/, '/:id') : '/'}`,
        status: res.status,
        body: await res.text(),
      };
    };
    const a = await own();
    const b = await own();
    const results = [
      await send(`/${a}`, 'PATCH', { title: 'w2' }),
      await send(`/${a}`, 'PUT', { title: 'w3', owner: member.userId }),
      await send('/bulk', 'PATCH', { records: [{ id: b, title: 'w4' }] }),
      await send(`/${a}`, 'DELETE'),
      await send('/bulk', 'DELETE', { ids: [b] }),
    ];
    for (const r of results) {
      expect({ op: r.op, ok: r.status < 300 && !r.body.includes('Forbidden') }).toEqual({
        op: r.op,
        ok: true,
      });
    }
    expect(new Set(seen)).toEqual(new Set(['member']));
  });
});
