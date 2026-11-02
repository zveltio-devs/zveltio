// The data API serves anonymous reads as the tenant's `public` role (ADR 0017).
//
// Before it, `routes/data.ts` answered 401 to any request without a session or
// an API key, although the tenant middleware already built the anonymous
// `public` identity for the database. Now a read runs as that role and is held
// to everything a signed-in role is: Casbin, the collection policies, row rules
// and column permissions. Pinned here, through the real routes:
//
//   - with no grant, `public` reads nothing (403, the granted-less role's answer);
//   - granted, it reads, under its row rule and its column permission;
//   - writes stay 401, and so does a refused API key;
//   - a grant in one tenant serves nothing in another;
//   - anonymous reads have their own, tighter, per-address rate limit.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import {
  collectionGrantsFor,
  getEnforcer,
  invalidateAllPermissionCaches,
  invalidateRlsCache,
  type RlsIdentity,
  runWithDomain,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import {
  asTenant,
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT_A = '00000000-0000-0000-0000-000000000001';
const SFX = String(Date.now()).slice(-7);
const B = { id: crypto.randomUUID(), slug: `anonb-${SFX}` };
const COLL = `anonread_${SFX}`;
const HIDDEN = `anonhide_${SFX}`;
const OWNED = `anonown_${SFX}`;

type Rec = Record<string, unknown>;

d('anonymous reads through the public role (ADR 0017)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let published = '';
  let draft = '';
  let ruleId = '';

  const anon = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
    app.request(path, { ...init, headers: { 'Content-Type': 'application/json', ...headers } });
  const grant = async (on: boolean, domain = TENANT_A) => {
    const e = await getEnforcer();
    if (on) await e.addPolicy('public', domain, COLL, 'read');
    else await e.removePolicy('public', domain, COLL, 'read');
    await invalidateAllPermissionCaches();
  };
  const create = async (body: Rec) => {
    const res = await app.request(`/api/data/${COLL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    const text = (name: string) =>
      ({ name, type: 'text', required: false, unique: false, indexed: false }) as never;
    for (const name of [COLL, HIDDEN]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [text('title'), text('status'), text('secret')],
      } as never);
    }
    published = await create({ title: 'pub', status: 'published', secret: 's1' });
    draft = await create({ title: 'draft', status: 'draft', secret: 's2' });
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${B.id}::uuid, ${B.slug}, 'anonb', 'active')`.execute(db);
    await asTenant(db, B.id, (trx) =>
      sql`INSERT INTO ${sql.table(`zvd_${COLL}`)} (title, status, tenant_id)
          VALUES ('other-firm', 'published', ${B.id}::uuid)`.execute(trx),
    );
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await grant(false).catch(() => {});
    if (ruleId) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${ruleId}::uuid`
        .execute(db)
        .catch(() => {});
      await invalidateRlsCache(COLL).catch(() => {});
    }
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLL}`
      .execute(db)
      .catch(() => {});
    await asTenant(db, B.id, (trx) =>
      sql`DELETE FROM ${sql.table(`zvd_${COLL}`)} WHERE tenant_id = ${B.id}::uuid`.execute(trx),
    ).catch(() => {});
    for (const name of [COLL, HIDDEN]) await dropTestCollection(db, name).catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${B.id}::uuid`.execute(db).catch(() => {});
  });

  it('(a) with no grant, public reads nothing: 403 on every read route, no rows', async () => {
    for (const path of [`/api/data/${COLL}`, `/api/data/${COLL}/${published}`]) {
      const res = await anon(path);
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain('pub');
    }
    const list = await anon('/api/data');
    expect(list.status).toBe(200);
    const names = ((await list.json()) as { collections: Rec[] }).collections.map((c) => c.name);
    expect(names).not.toContain(COLL);
  });

  it('(b) granted read: rows, under the row rule and the column permission', async () => {
    await grant(true);
    const rule = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        collection: COLL,
        role: 'public',
        filter_field: 'status',
        filter_op: 'eq',
        filter_value_source: 'static:published',
      }),
    });
    expect(rule.status).toBe(201);
    ruleId = ((await rule.json()) as { policy: { id: string } }).policy.id;
    const col = await app.request('/api/admin/column-permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        collection_name: COLL,
        column_name: 'secret',
        role: 'public',
        can_read: false,
        can_write: false,
      }),
    });
    expect([200, 201]).toContain(col.status);

    const res = await anon(`/api/data/${COLL}`);
    expect(res.status).toBe(200);
    const records = ((await res.json()) as { records: Rec[] }).records;
    // The draft is the row rule's; `other-firm` is tenant B's.
    expect(records.map((r) => r.title)).toEqual(['pub']);
    expect(records[0]!.secret).toBeUndefined();

    const one = await anon(`/api/data/${COLL}/${published}`);
    expect(one.status).toBe(200);
    const rec = (await one.json()) as Rec;
    expect(rec.title).toBe('pub');
    expect(rec.secret).toBeUndefined();
    expect((await anon(`/api/data/${COLL}/${draft}`)).status).toBe(404);
    // Time travel answers under the same rules.
    const asOf = encodeURIComponent(new Date(Date.now() + 1000).toISOString());
    expect((await anon(`/api/data/${COLL}/${draft}?as_of=${asOf}`)).status).toBe(404);

    const list = await anon('/api/data');
    const listed = ((await list.json()) as { collections: Rec[] }).collections;
    const mine = listed.find((c) => c.name === COLL) as { fields: Rec[] } | undefined;
    expect(mine?.fields.map((f) => f.name)).not.toContain('secret');
    expect(listed.map((c) => c.name)).not.toContain(HIDDEN);

    // The signed-in path is untouched: god still reads every row and column
    // (every firm's too: god's read bypass is instance-wide).
    const godRes = await app.request(`/api/data/${COLL}`, { headers: { cookie: god } });
    const godRows = ((await godRes.json()) as { records: Rec[] }).records;
    expect(godRows.map((r) => r.title)).toContain('draft');
    expect(godRows.find((r) => r.title === 'pub')!.secret).toBe('s1');
  });

  it('(c) writes stay 401 for an anonymous caller, granted or not', async () => {
    const e = await getEnforcer();
    for (const a of ['create', 'update', 'delete']) await e.addPolicy('public', TENANT_A, COLL, a);
    await invalidateAllPermissionCaches();
    try {
      const body = JSON.stringify({ title: 'x' });
      const tries: Array<[string, string, string?]> = [
        ['POST', `/api/data/${COLL}`, body],
        ['PUT', `/api/data/${COLL}/${published}`, body],
        ['PATCH', `/api/data/${COLL}/${published}`, body],
        ['DELETE', `/api/data/${COLL}/${published}`],
        ['POST', `/api/data/${COLL}/bulk`, JSON.stringify({ records: [{ title: 'x' }] })],
        ['PATCH', `/api/data/${COLL}/bulk`, JSON.stringify({ ids: [published], data: {} })],
        ['DELETE', `/api/data/${COLL}/bulk`, JSON.stringify({ ids: [published] })],
      ];
      for (const [method, path, b] of tries) {
        expect([method, path, (await anon(path, { method, body: b })).status]).toEqual([
          method,
          path,
          401,
        ]);
      }
    } finally {
      for (const a of ['create', 'update', 'delete'])
        await e.removePolicy('public', TENANT_A, COLL, a);
      await invalidateAllPermissionCaches();
    }
    // Nothing landed.
    const godRes = await app.request(`/api/data/${COLL}`, { headers: { cookie: god } });
    const titles = ((await godRes.json()) as { records: Rec[] }).records.map((r) => r.title);
    expect(titles).not.toContain('x');
    expect(titles).toContain('pub');
  });

  it('a refused API key is 401, not a visitor', async () => {
    const bad = `zvk_${'0'.repeat(32)}`;
    expect((await anon(`/api/data/${COLL}`, {}, { 'X-API-Key': bad })).status).toBe(401);
    expect((await anon(`/api/data/${COLL}`, {}, { Authorization: `Bearer ${bad}` })).status).toBe(
      401,
    );
    // The scheme is case-insensitive (RFC 9110): a lower-case one still presents a key.
    expect((await anon(`/api/data/${COLL}`, {}, { Authorization: `bearer ${bad}` })).status).toBe(
      401,
    );
  });

  describe('a caller with no id or email owns nothing through `user_id` / `user_email`', () => {
    // `''` was compared like any value, so a `<col> eq user_id` rule handed an
    // anonymous caller, or an email-less key, every row whose column is blank.
    let keyId = '';
    let raw = '';
    let blank = '';
    const titles = async (res: Response) => {
      expect(res.status).toBe(200);
      return ((await res.json()) as { records: Rec[] }).records.map((r) => r.title).sort();
    };
    /** The database policy alone: a raw statement under the anonymous identity. */
    const viaDatabase = async () => {
      const g = await runWithDomain(TENANT_A, () => collectionGrantsFor('public'));
      const identity: RlsIdentity = {
        userId: '',
        email: '',
        role: 'public',
        roles: ['public'],
        bypass: false,
        collectionGrants: g.grants,
        collectionAll: g.all,
        anonymous: true,
      };
      return withTenantIsolation(
        TENANT_A,
        async (trx) =>
          (
            await sql<{ title: string }>`
              SELECT title FROM ${sql.table(`zvd_${OWNED}`)} ORDER BY title`.execute(trx)
          ).rows.map((r) => r.title),
        { identity },
      );
    };
    const withRule = async (
      role: string,
      field: string,
      source: string,
      fn: () => Promise<void>,
    ) => {
      const res = await app.request('/api/admin/rls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: god },
        body: JSON.stringify({
          collection: OWNED,
          role,
          filter_field: field,
          filter_op: 'eq',
          filter_value_source: source,
        }),
      });
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { policy: { id: string } }).policy.id;
      try {
        await fn();
      } finally {
        await app.request(`/api/admin/rls/${id}`, { method: 'DELETE', headers: { cookie: god } });
      }
    };

    beforeAll(async () => {
      const text = (name: string) =>
        ({ name, type: 'text', required: false, unique: false, indexed: false }) as never;
      await DDLManager.createCollection(db, {
        name: OWNED,
        fields: [text('title'), text('owner'), text('owner_email')],
      } as never);
      for (const [title, owner] of [
        ['blank', ''],
        ['set', 'someone@test.local'],
      ]) {
        const res = await app.request(`/api/data/${OWNED}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie: god },
          body: JSON.stringify({ title, owner, owner_email: owner }),
        });
        expect(res.status).toBe(201);
        if (title === 'blank') blank = ((await res.json()) as { id: string }).id;
      }
      const e = await getEnforcer();
      await e.addPolicy('public', TENANT_A, OWNED, 'read');
      await invalidateAllPermissionCaches();
      // An email-less key, its rules enforced; its issuer (god) is exempt from
      // row rules, so only the key's own half binds.
      const godId = (
        await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god' LIMIT 1`.execute(db)
      ).rows[0]!.id;
      raw = generateApiKey();
      keyId = (
        await sql<{ id: string }>`
          INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, rate_limit, is_active,
                                   tenant_id, created_by, rls_bypass)
          VALUES ('anon owner probe', ${await hashApiKey(raw)}, 'zvk_',
                  ${JSON.stringify([{ collection: OWNED, actions: ['read'] }])}::jsonb, 100, true,
                  ${TENANT_A}::uuid, ${godId}, false)
          RETURNING id`.execute(db)
      ).rows[0]!.id;
    });

    afterAll(async () => {
      const e = await getEnforcer();
      await e.removePolicy('public', TENANT_A, OWNED, 'read').catch(() => {});
      await invalidateAllPermissionCaches();
      await sql`DELETE FROM zv_api_keys WHERE id = ${keyId}::uuid`.execute(db).catch(() => {});
      await sql`DELETE FROM zvd_rls_policies WHERE collection = ${OWNED}`
        .execute(db)
        .catch(() => {});
      await invalidateRlsCache(OWNED).catch(() => {});
      await dropTestCollection(db, OWNED).catch(() => {});
    });

    for (const [field, source] of [
      ['owner', 'user_id'],
      ['owner_email', 'user_email'],
    ] as const) {
      it(`anonymous, under \`${field} eq ${source}\`: no row, on every path`, async () => {
        await withRule('*', field, source, async () => {
          expect(await titles(await anon(`/api/data/${OWNED}`))).toEqual([]);
          const asOf = encodeURIComponent(new Date(Date.now() + 1000).toISOString());
          expect((await anon(`/api/data/${OWNED}/${blank}?as_of=${asOf}`)).status).toBe(404);
          expect(await viaDatabase()).toEqual([]);
        });
      });
    }

    it('an email-less API key, under `owner_email eq user_email`: no row', async () => {
      await withRule('api_key', 'owner_email', 'user_email', async () => {
        expect(await titles(await anon(`/api/data/${OWNED}`, {}, { 'X-API-Key': raw }))).toEqual(
          [],
        );
      });
      // The control: without the rule the key reads both, so the empty answer
      // above is the rule's — and a lower-case scheme is the key, not a visitor
      // (`public` loses its grant here, so a visitor would get 403).
      const e = await getEnforcer();
      await e.removePolicy('public', TENANT_A, OWNED, 'read');
      await invalidateAllPermissionCaches();
      try {
        expect(
          await titles(await anon(`/api/data/${OWNED}`, {}, { Authorization: `bearer ${raw}` })),
        ).toEqual(['blank', 'set']);
      } finally {
        await e.addPolicy('public', TENANT_A, OWNED, 'read');
        await invalidateAllPermissionCaches();
      }
    });
  });

  it('(d) a public grant in tenant A serves nothing in tenant B', async () => {
    const inB = { 'x-tenant-slug': B.slug };
    const res = await anon(`/api/data/${COLL}`, {}, inB);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('other-firm');
    const list = await anon('/api/data', {}, inB);
    const names = ((await list.json()) as { collections: Rec[] }).collections.map((c) => c.name);
    expect(names).not.toContain(COLL);
    // While A, where it was granted, still serves A's row.
    expect((await anon(`/api/data/${COLL}`)).status).toBe(200);
  });

  it('anonymous reads have their own per-address limit, tighter than a signed-in caller', async () => {
    const savedEnv = process.env.NODE_ENV;
    const savedProxy = process.env.TRUSTED_PROXY;
    process.env.NODE_ENV = 'development'; // the limiter bypasses itself under 'test'
    process.env.TRUSTED_PROXY = 'true';
    try {
      const ip = { 'x-forwarded-for': `203.0.113.${(Number(SFX) % 200) + 20}` };
      const seen: number[] = [];
      for (let i = 0; i < 101; i++) seen.push((await anon(`/api/data/${HIDDEN}`, {}, ip)).status);
      expect(seen.slice(0, 100)).not.toContain(429);
      expect(seen[100]).toBe(429);
      // A signed-in caller from the same address is not on that budget.
      const signed = await app.request(`/api/data/${COLL}`, { headers: { cookie: god, ...ip } });
      expect(signed.status).toBe(200);
    } finally {
      if (savedEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedEnv;
      if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
      else process.env.TRUSTED_PROXY = savedProxy;
    }
  }, 60_000);
});
