/**
 * ADR 0024: a `secret` field is write-only for everyone but the extension that
 * owns its collection, which reads the plaintext through `host.collections`
 * (actions and jobs) and nowhere else.
 *
 * The doors `password` already closes — REST as god, filter and sort, the
 * revision row, webhooks, realtime, flows — are covered for `secret` in
 * `withheld-fields-every-door.test.ts`. This file holds what is `secret`'s own:
 * the owner's reveal, its absence for anyone else, storage (always encrypted,
 * planted ciphertext encrypted again, no key = refused) and the retype rules.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { unregisterJobs } from '../../lib/extensions/jobs.js';
import { DDLManager, decryptField, encryptField } from '../../lib/data/index.js';
import { alterField, dropField } from '../../lib/data/field-changes.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { toJsonb } from '../../lib/jsonb.js';
import {
  asEveryTenant,
  createMemberSession,
  createSteppedUpGod,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() && process.env.FIELD_ENCRYPTION_KEY ? describe : describe.skip;
const STAMP = Date.now();
/** Owned by EXT: `tok` is its secret. */
const S = `sec_s_${STAMP}`;
/** Nobody's: plain text `p`, `encrypted: true` text `k` and boolean `b`, each retyped to `secret`. */
const R = `sec_r_${STAMP}`;
const RES = `sec_res_${STAMP}`;
const EXT = `sec-ext-${STAMP}`;
const OTHER = `sec-other-${STAMP}`;
const TOKEN = 'anaf-refresh-token-1b9e';

const field = (name: string, type: string) => ({
  name,
  type,
  required: false,
  unique: false,
  indexed: false,
});
const any = { type: 'object' };

d('a secret field: write-only, read back by its own extension alone (ADR 0024)', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let god: { app: Hono; cookie: string };
  let member: { cookie: string; userId: string };

  function loader(ctx: ExtensionContext): ExtensionLoader {
    return {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
  }
  async function load(ext: ZveltioExtension, manifest: Record<string, unknown>): Promise<void> {
    const parsed = ManifestSchema.parse({ name: ext.name, ...manifest });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${ext.name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${ext.name}, ${ext.name}, NULL, true, true, ${toJsonb(parsed)})
    `.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    await finalizeExtensionLoad(
      loader(ctx),
      ext,
      ext.name,
      `/tmp/${ext.name}`,
      app,
      ctx,
      parsed as never,
      new Set(),
    );
  }

  const send = (target: Hono, method: string, path: string, body: unknown, cookie: string) =>
    target.request(path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const asMember = (method: string, path: string, body?: unknown) =>
    send(engine, method, path, body, member.cookie);
  const act = async (ext: string, name: string, body: unknown) => {
    const res = await send(app, 'POST', `/ext/${ext}/actions/${name}`, body, member.cookie);
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: Record<string, unknown> }).result;
  };
  const stored = async (table: string, id: string, column = 'tok') =>
    (
      await sql<{ v: string | null }>`
        SELECT ${sql.ref(column)} AS v FROM ${sql.table(`zvd_${table}`)} WHERE id = ${id}`.execute(
        db,
      )
    ).rows[0]?.v;
  const create = async (body: Record<string, unknown>) => {
    const res = await asMember('POST', `/api/data/${S}`, body);
    expect(res.status).toBe(201);
    return String(((await res.json()) as { id: string }).id);
  };

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    await DDLManager.createCollection(
      db,
      { name: S, fields: [field('label', 'text'), field('tok', 'secret')] } as never,
      { extension: EXT, defaultGrants: true },
    );
    await DDLManager.createCollection(db, {
      name: R,
      fields: [
        field('p', 'text'),
        { ...field('k', 'text'), encrypted: true },
        field('b', 'boolean'),
      ],
    } as never);
    const all = ['read', 'create', 'update', 'delete'];
    member = await createMemberSession(engine, db, {
      grants: [
        { collection: S, actions: all },
        { collection: RES, actions: ['execute'] },
      ],
    });
    god = await createSteppedUpGod(engine, db);

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    const action = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      permission: { resource: RES },
      input: any,
      reads: [S],
      writes: [],
      ...extra,
    });
    type Input = { id: string };
    const reader: ZveltioExtension['actions'] = {
      get: (input, host) => host.collections.read(S, (input as Input).id),
      all: (_input, host) => host.collections.list(S, { limit: 100 }),
    };
    await load(
      {
        name: EXT,
        category: 'custom',
        mountStrategy: 'subapp',
        actions: {
          ...reader,
          queueCopy: async (input, host) => ({ job: await host.enqueue('copyToken', input) }),
        },
        jobs: {
          // Writes what the job read into a served column, so the test can see it.
          copyToken: async (input, host) => {
            const { id } = input as Input;
            const r = await host.collections.read(S, id);
            await host.collections.update(S, id, { label: `job:${String(r?.tok)}` });
          },
        },
        async register(sub, ctx) {
          // The extension's own code outside `host.collections`.
          sub.get('/own/:id', async (c) =>
            c.json((await ctx.internals!.readRecord(c, S, c.req.param('id'))).body),
          );
        },
      },
      {
        permissions: ['data:write', 'data:system'],
        resources: [RES],
        actions: [action('get'), action('all'), action('queueCopy', { enqueues: ['copyToken'] })],
        jobs: [{ name: 'copyToken', input: any, reads: [S], writes: [S], retry: { limit: 0 } }],
      },
    );
    await load(
      {
        name: OTHER,
        category: 'custom',
        mountStrategy: 'subapp',
        actions: reader,
        async register() {},
      },
      {
        permissions: ['data:write'],
        resources: [RES],
        dependencies: [{ name: EXT }],
        actions: [action('get'), action('all')],
      },
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    await unregisterJobs(EXT);
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${OTHER})`.execute(db);
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_revisions WHERE collection IN (${S}, ${R})`.execute(trx),
    );
    for (const c of [S, R]) await dropTestCollection(db, c);
  });

  it('stores ciphertext, and the data API serves no secret to god or the writer', async () => {
    const id = await create({ label: 'a', tok: TOKEN });
    expect((await stored(S, id))?.startsWith('enc:v1:')).toBe(true);
    for (const [who, res] of [
      ['member', await asMember('GET', `/api/data/${S}/${id}`)],
      ['god', await send(god.app, 'GET', `/api/data/${S}/${id}`, undefined, god.cookie)],
      ['god list', await send(god.app, 'GET', `/api/data/${S}`, undefined, god.cookie)],
    ] as const) {
      const text = await res.text();
      expect(`${who} ${res.status} ${text.includes(TOKEN)} ${text.includes('"tok"')}`).toBe(
        `${who} 200 false false`,
      );
    }
  });

  it('the owning extension reads the plaintext through host.collections read and list', async () => {
    const id = await create({ label: 'b', tok: TOKEN });
    expect((await act(EXT, 'get', { id })).tok).toBe(TOKEN);
    const listed = (await act(EXT, 'all', {})).records as Record<string, unknown>[];
    expect(listed.find((r) => r.id === id)?.tok).toBe(TOKEN);
  });

  it('another extension declaring the collection in reads gets no secret', async () => {
    const id = await create({ label: 'c', tok: TOKEN });
    const one = await act(OTHER, 'get', { id });
    expect(one.label).toBe('c');
    expect('tok' in one).toBe(false);
    expect(JSON.stringify(await act(OTHER, 'all', {}))).not.toContain(TOKEN);
  });

  it('ctx.internals record reads give the owner no secret either', async () => {
    const id = await create({ label: 'd', tok: TOKEN });
    const res = await send(app, 'GET', `/ext/${EXT}/own/${id}`, undefined, member.cookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"label":"d"');
    expect(text).not.toContain(TOKEN);
  });

  it("the owner's job reads the plaintext through its host.collections", async () => {
    const id = await create({ label: 'e', tok: TOKEN });
    await act(EXT, 'queueCopy', { id });
    let label: string | null | undefined;
    for (let i = 0; i < 150 && !label?.startsWith('job:'); i++) {
      label = await stored(S, id, 'label');
      if (!label?.startsWith('job:')) await Bun.sleep(100);
    }
    expect(label).toBe(`job:${TOKEN}`);
  });

  it('absent keeps the secret, a new value replaces it, null clears it', async () => {
    const id = await create({ label: 'f', tok: TOKEN });
    expect((await asMember('PATCH', `/api/data/${S}/${id}`, { label: 'g' })).status).toBe(200);
    expect((await act(EXT, 'get', { id })).tok).toBe(TOKEN);
    expect((await asMember('PATCH', `/api/data/${S}/${id}`, { tok: 'second' })).status).toBe(200);
    expect((await stored(S, id))?.startsWith('enc:v1:')).toBe(true);
    expect((await act(EXT, 'get', { id })).tok).toBe('second');
    const put = await asMember('PUT', `/api/data/${S}/${id}`, { label: 'g', tok: 'third' });
    expect(put.status).toBe(200);
    expect((await stored(S, id))?.startsWith('enc:v1:')).toBe(true);
    expect((await act(EXT, 'get', { id })).tok).toBe('third');
    expect((await asMember('PATCH', `/api/data/${S}/${id}`, { tok: null })).status).toBe(200);
    expect(await stored(S, id)).toBeNull();
    expect((await act(EXT, 'get', { id })).tok).toBeNull();
  });

  it('a planted enc:v1: value is encrypted again, never stored as given', async () => {
    const planted = await encryptField('copied-from-another-row');
    const id = await create({ label: 'h', tok: planted });
    const v = await stored(S, id);
    expect(v).not.toBe(planted);
    expect(await decryptField(v!)).toBe(planted);
    expect((await act(EXT, 'get', { id })).tok).toBe(planted);
  });

  it('is sealed in the database: no request role may SELECT it', async () => {
    const roles = await sql<{ role: string; ok: boolean }>`
      SELECT rolname AS role, has_column_privilege(oid, ${`zvd_${S}`}::regclass, 'tok', 'SELECT') AS ok
        FROM pg_roles
       WHERE rolname IN ('zveltio_rls', 'zveltio_worker', 'zveltio_flow_reader', 'zveltio_ext')
       ORDER BY rolname`.execute(db);
    expect(roles.rows.length).toBe(4);
    for (const r of roles.rows) expect(`${r.role} ${r.ok}`).toBe(`${r.role} false`);
  });

  it('without FIELD_ENCRYPTION_KEY a write is refused, and plaintext mode does not apply', async () => {
    const key = process.env.FIELD_ENCRYPTION_KEY;
    const id = await create({ label: 'i', tok: TOKEN });
    const before = await stored(S, id);
    delete process.env.FIELD_ENCRYPTION_KEY;
    process.env.ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS = '1';
    try {
      const made = await asMember('POST', `/api/data/${S}`, { label: 'j', tok: TOKEN });
      expect(made.status).toBeGreaterThanOrEqual(400);
      const patched = await asMember('PATCH', `/api/data/${S}/${id}`, { tok: 'plain' });
      expect(patched.status).toBeGreaterThanOrEqual(400);
      // The collection still installs; its secret stays empty.
      const empty = `sec_nokey_${STAMP}`;
      await DDLManager.createCollection(db, {
        name: empty,
        fields: [field('tok', 'secret')],
      } as never);
      await dropTestCollection(db, empty);
    } finally {
      process.env.FIELD_ENCRYPTION_KEY = key;
      delete process.env.ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS;
    }
    expect(await stored(S, id)).toBe(before);
    const raw = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(`zvd_${S}`)} WHERE label = 'j'`.execute(db);
    expect(raw.rows[0]?.n).toBe(0);
  });

  it('a database CHECK refuses plaintext in a secret column, even from the table owner', async () => {
    const raw = await sql`INSERT INTO ${sql.table(`zvd_${S}`)} (tok) VALUES ('plain')`
      .execute(db)
      .then(
        () => null,
        (err: { errno?: string }) => err.errno,
      );
    expect(raw).toBe('23514');
  });

  it('a retype to secret encrypts the column, drops its default, adds the CHECK and scrubs every copy', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, text: async () => 'ok' }) as Response) as unknown as typeof fetch;
    const asGod = (method: string, path: string, body?: unknown) =>
      send(god.app, method, path, body, god.cookie);
    let webhookId = '';
    try {
      const wh = await asGod('POST', '/api/webhooks', {
        name: `secret retype ${STAMP}`,
        url: 'https://example.test/hook',
        events: ['insert', 'update'],
        collections: [R],
      });
      const whBody = (await wh.json()) as { id?: string; webhook?: { id: string } };
      webhookId = whBody.id ?? whBody.webhook!.id;
      const planted = await encryptField('planted-in-plain-text');
      const one = await asGod('POST', `/api/data/${R}`, {
        p: 'plain-value',
        k: 'field-encrypted',
        b: true,
      });
      expect(one.status).toBe(201);
      const oneId = ((await one.json()) as { id: string }).id;
      const patched = await asGod('PATCH', `/api/data/${R}/${oneId}`, { p: 'plain-value-2' });
      expect(patched.status).toBe(200);
      const two = await asGod('POST', `/api/data/${R}`, { p: planted });
      const twoId = ((await two.json()) as { id: string }).id;
      const keptK = await stored(R, oneId, 'k');
      expect(keptK?.startsWith('enc:v1:')).toBe(true);
      const copies = async () => {
        const revs = await sql<{ j: string }>`
          SELECT data::text || coalesce(delta::text, '') AS j FROM zv_revisions
           WHERE collection = ${R}`.execute(db);
        const dels = await sql<{ j: string }>`
          SELECT payload::text AS j FROM zvd_webhook_deliveries WHERE webhook_id = ${webhookId}`.execute(
          db,
        );
        return [...revs.rows, ...dels.rows].map((r) => r.j).join('\n');
      };
      let before = '';
      for (let i = 0; i < 50 && !before.includes('"event": "update"'); i++) {
        before = await copies();
        await Bun.sleep(50);
      }
      expect(before).toContain('plain-value-2');

      for (const f of ['p', 'k', 'b']) await alterField(db, R, f, { newType: 'secret' });

      const after = await copies();
      expect(after).not.toContain('plain-value');
      expect(after).not.toContain('"p"');
      expect(after).not.toContain('"b"');
      // A plain text column's planted ciphertext is encrypted again; only an
      // `encrypted: true` field's own ciphertext is kept.
      const p2 = await stored(R, twoId, 'p');
      expect(p2).not.toBe(planted);
      expect(await decryptField(p2!)).toBe(planted);
      expect(await decryptField((await stored(R, oneId, 'p'))!)).toBe('plain-value-2');
      expect(await stored(R, oneId, 'k')).toBe(keptK);
      expect(await decryptField((await stored(R, oneId, 'b'))!)).toBe('true');
      // The boolean's DEFAULT false is gone: a row that omits it stores NULL.
      const blank = await sql<{ b: string | null }>`
        INSERT INTO ${sql.table(`zvd_${R}`)} (p) VALUES (NULL) RETURNING b`.execute(db);
      expect(blank.rows[0]?.b).toBeNull();
      const plain = await sql`INSERT INTO ${sql.table(`zvd_${R}`)} (b) VALUES ('false')`
        .execute(db)
        .then(
          () => null,
          (err: { errno?: string }) => err.errno,
        );
      expect(plain).toBe('23514');
      const rls = await sql<{ ok: boolean }>`
        SELECT has_column_privilege('zveltio_rls', ${`zvd_${R}`}::regclass, 'p', 'SELECT') AS ok`.execute(
        db,
      );
      expect(rls.rows[0]?.ok).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      if (webhookId) {
        await sql`DELETE FROM zvd_webhook_deliveries WHERE webhook_id = ${webhookId}`.execute(db);
        await sql`DELETE FROM zvd_webhooks WHERE id = ${webhookId}`.execute(db);
      }
    }
  });

  it('the CHECK goes with the field', async () => {
    const checks = async () =>
      (
        await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pg_constraint
           WHERE conrelid = ${`zvd_${R}`}::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%enc:v1:%'`.execute(db)
      ).rows[0]?.n;
    expect(await checks()).toBe(3);
    await dropField(db, R, 'b');
    expect(await checks()).toBe(2);
  });

  it('takes no unique key or index: they mean nothing on random-IV ciphertext', async () => {
    for (const extra of [{ unique: true }, { indexed: true }]) {
      const name = `sec_key_${STAMP}`;
      const created = await DDLManager.createCollection(db, {
        name,
        fields: [{ ...field('tok', 'secret'), ...extra }],
      } as never).then(
        () => null,
        (err: Error) => err.message,
      );
      expect(created).toContain('cannot be unique or indexed');
      await dropTestCollection(db, name).catch(() => {});
      const set = await alterField(db, S, 'tok', extra, EXT).then(
        () => null,
        (err: { status?: number }) => err.status,
      );
      expect(set).toBe(400);
    }
  });

  it('takes no column default, which Postgres would write past the encryption', async () => {
    const name = `sec_def_${STAMP}`;
    const created = await DDLManager.createCollection(db, {
      name,
      fields: [{ ...field('tok', 'secret'), defaultValue: 'plain' }],
    } as never).then(
      () => null,
      (err: Error) => err.message,
    );
    expect(created).toContain('takes no default');
    await dropTestCollection(db, name).catch(() => {});
    const set = await alterField(db, S, 'tok', { defaultValue: 'plain' }, EXT).then(
      () => null,
      (err: { status?: number }) => err.status,
    );
    expect(set).toBe(400);
  });

  it('a retype from secret is refused, and the column stays sealed ciphertext', async () => {
    const id = await create({ label: 'k', tok: TOKEN });
    const before = await stored(S, id);
    const refused = await alterField(db, S, 'tok', { newType: 'text' }, EXT).then(
      () => null,
      (err: { status?: number; message?: string }) => err,
    );
    expect(refused?.status).toBe(400);
    expect(refused?.message).toContain('secret');
    expect(await stored(S, id)).toBe(before);
  });
});
