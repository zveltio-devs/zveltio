/**
 * An API-key request needs one connection, its issuer's caches cold included.
 *
 * A key is resolved inside the handler, so everything asked of its issuer —
 * the god flag, the roles the live model has not loaded, the email a row rule
 * resolves — was asked inside the request transaction, on the pool. Session
 * users are warmed before the transaction opens (`sessionPrefetch`); a key's
 * issuer was not. So a key idle past the 5 s local memo took a second
 * connection per request, and at `c = DB_POOL_MAX` every connection was held
 * by a transaction waiting for one more, until the 35 s acquire deadline.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _setConnectionTracing, tracedAcquisitionSite } from '../../db/connection-trace.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import {
  applyRowRulePolicy,
  DEFAULT_TENANT_ID,
  getEnforcer,
  invalidateGodCache,
} from '../../lib/tenancy/index.js';
import {
  createKeyCreator,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const C = `keyonecon_${Date.now()}`;
const pool = Number(process.env.DB_POOL_MAX ?? '10');

d('an API-key request needs one connection (in-process)', () => {
  let app: Hono;
  let db: Database;
  const keys: Record<string, { raw: string; issuer: string }> = {};
  let memberCookie = '';

  const cold = async () => {
    for (const k of Object.values(keys)) await invalidateGodCache(k.issuer);
  };
  const send = (key: string, method: string, path = '', body?: unknown) =>
    app.request(`/api/data/${C}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-api-key': keys[key]!.raw },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const extra = (res: Response) => {
    const n = res.headers.get('x-zveltio-extra-connections') ?? '0';
    return `${res.status} ${n}${n === '0' ? '' : ` — ${tracedAcquisitionSite()}`}`;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    // An administrator (exempt from row rules) and a member held to them.
    const admin = await createKeyCreator(db);
    const { userId: member, cookie } = await createMemberSession(app, db, {
      grants: [
        { collection: C, actions: ['read', 'create'] },
        { collection: '$edge', actions: ['execute'] },
      ],
    });
    memberCookie = cookie;
    // A row rule, so the read resolves the rules and the issuer's half of them.
    await sql`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${C}, '*', 'title', 'neq', 'static:hidden', true)`.execute(db);
    await applyRowRulePolicy(db, C);
    for (const [name, issuer] of [
      ['admin', admin],
      ['member', member],
    ] as const) {
      const raw = generateApiKey();
      await sql`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
        VALUES (${`${C}-${name}`}, ${await hashApiKey(raw)}, ${raw.slice(0, 12)},
                ${JSON.stringify([
                  { collection: C, actions: ['*'] },
                  { collection: '$edge', actions: ['execute'] },
                  { collection: '$storage', actions: ['*'] },
                  { collection: '$rpc', actions: ['execute'] },
                ])}::jsonb, true,
                ${DEFAULT_TENANT_ID}::uuid, ${issuer})`.execute(db);
      keys[name] = { raw, issuer };
    }
  });

  // Long enough to outlast the 35 s acquire deadline a red run leaves behind.
  afterAll(async () => {
    _setConnectionTracing(false);
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${C}-%`}`.execute(db);
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${C}`.execute(db);
    await dropTestCollection(db, C);
  }, 60_000);

  it('a key read and write with cold issuer caches take nothing beyond the transaction', async () => {
    const seen: Record<string, string> = {};
    _setConnectionTracing(true);
    try {
      for (const k of ['admin', 'member']) {
        await cold();
        seen[`${k} POST`] = extra(await send(k, 'POST', '', { title: k }));
        await cold();
        seen[`${k} GET`] = extra(await send(k, 'GET'));
      }
      // The row rules were read on the pool for a session too.
      seen['member session GET'] = extra(
        await app.request(`/api/data/${C}`, { headers: { cookie: memberCookie } }),
      );
    } finally {
      _setConnectionTracing(false);
    }
    expect(seen).toEqual({
      'admin POST': '201 0',
      'admin GET': '200 0',
      'member POST': '201 0',
      'member GET': '200 0',
      'member session GET': '200 0',
    });
  }, 60_000);

  it('the other doors a key opens take nothing beyond the transaction', async () => {
    // Refused past authentication (404) is enough: the key and its issuer are
    // asked before the route looks for the function.
    const seen: Record<string, string> = {};
    const probe = async (label: string, path: string, init: RequestInit) => {
      await cold();
      _setConnectionTracing(true);
      try {
        const res = await app.request(path, init);
        seen[label] = extra(res);
        await res.body?.cancel().catch(() => {});
      } finally {
        _setConnectionTracing(false);
      }
    };
    for (const k of ['admin', 'member']) {
      const headers = { 'Content-Type': 'application/json', 'x-api-key': keys[k]!.raw };
      await probe(`${k} sse`, `/api/realtime/stream?collection=${C}`, { headers });
      await probe(`${k} fn`, `/api/fn/none_${C}`, { method: 'POST', headers, body: '{}' });
      await probe(`${k} storage`, '/api/storage', { headers });
      await probe(`${k} rpc`, '/api/rpc/none_fn', { method: 'POST', headers, body: '{}' });
    }
    await probe('member session sse', `/api/realtime/stream?collection=${C}`, {
      headers: { cookie: memberCookie },
    });
    expect(seen).toEqual({
      'admin sse': '200 0',
      'admin fn': '404 0',
      'admin storage': '200 0',
      'admin rpc': '404 0',
      'member sse': '200 0',
      'member fn': '404 0',
      'member storage': '200 0',
      'member rpc': '404 0',
      'member session sse': '200 0',
    });
  }, 60_000);

  it('so does an issuer whose member row this replica has not loaded', async () => {
    // A user another replica created before the bus delivered: the table has
    // the row, this model does not (`unloadedRoles`).
    const issuer = keys.member!.issuer;
    const model = (await getEnforcer()).getModel();
    model.removePolicy('g', 'g', [issuer, 'member', '*']);
    _setConnectionTracing(true);
    try {
      await cold();
      expect(extra(await send('member', 'GET'))).toBe('200 0');
    } finally {
      _setConnectionTracing(false);
      model.addPolicy('g', 'g', [issuer, 'member', '*']);
      await cold();
    }
  }, 60_000);

  it('a cold burst of key reads at twice the pool size completes', async () => {
    await cold();
    const statuses = await Promise.race([
      Promise.all(
        Array.from({ length: pool * 2 }, (_, n) =>
          Promise.resolve(send(n % 2 ? 'member' : 'admin', 'GET')).then((r) => r.status),
        ),
      ),
      Bun.sleep(15_000).then(() => 'HANG'),
    ]);
    expect(statuses).toEqual(Array.from({ length: pool * 2 }, () => 200));
  }, 60_000);
});
