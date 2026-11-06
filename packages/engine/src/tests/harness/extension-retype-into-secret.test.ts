/**
 * An extension's update that turns its text field `secret` (ADR 0024 §6).
 *
 * auth/ldap 2.0.0 declared `bind_password` as `text` + `encrypted: true`, and
 * 2.1.0 as `secret`. The extension plan had no op for a type change, so every
 * install of 2.0.0 refused to load 2.1.0 ("a drop, rename or type change needs
 * schema migration ops"); a retype by hand left `encrypted: true` in the field's
 * metadata, a step the plan then owed forever. Now the retype is the update's
 * own step: the field key's ciphertext stays as it is, plaintext is encrypted,
 * a unique key goes, and the next load owes nothing. Any other type change is
 * still refused.
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
import { applyDeclaredCollections } from '../../lib/extensions/declared-collections.js';
import { planExtensionSchema } from '../../lib/schema-artifact/apply.js';
import { DDLManager, decryptField, maybeEncrypt } from '../../lib/data/index.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { toJsonb } from '../../lib/jsonb.js';
import {
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() && process.env.FIELD_ENCRYPTION_KEY ? describe : describe.skip;
const STAMP = Date.now();
const C = `rts_${STAMP}`;
const RES = `rts_res_${STAMP}`;
const EXT = `rts-ext-${STAMP}`;

/** The collection file: `tok` and `pin` as 2.0.0 declared them, or as `secret`. */
const file = (as: 'text' | 'secret', label = 'text') => ({
  [`collections/${C}.json`]: JSON.stringify({
    name: C,
    fields: [
      { name: 'label', type: label },
      // The field key's ciphertext, as an `encrypted` field holds it.
      as === 'text'
        ? { name: 'tok', type: 'text', required: true, encrypted: true, indexed: true }
        : { name: 'tok', type: 'secret', required: true },
      // Plaintext, under a unique key and a default a secret cannot keep.
      as === 'text'
        ? { name: 'pin', type: 'textarea', unique: true, defaultValue: 'none' }
        : { name: 'pin', type: 'secret' },
    ],
  }),
});

d("an extension's update turns its text field secret (ADR 0024 §6)", () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let member: { cookie: string };
  const ids: string[] = [];
  const sealed: string[] = [];

  const raw = async () =>
    (
      await sql<{ id: string; tok: string; pin: string }>`
        SELECT id::text AS id, tok, pin FROM ${sql.table(`zvd_${C}`)} ORDER BY label`.execute(db)
    ).rows;

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    await applyDeclaredCollections(db, EXT, file('text'), true);
    for (const n of [1, 2]) {
      const tok = await maybeEncrypt(`tok-${n}`, true);
      sealed.push(String(tok));
      const row = await sql<{ id: string }>`
        INSERT INTO ${sql.table(`zvd_${C}`)} (label, tok, pin)
        VALUES (${`row-${n}`}, ${tok}, ${`pin-${n}`}) RETURNING id::text AS id`.execute(db);
      ids.push(row.rows[0]!.id);
    }
    member = await createMemberSession(engine, db, {
      grants: [
        { collection: C, actions: ['read'] },
        { collection: RES, actions: ['execute'] },
      ],
    });

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    const ext: ZveltioExtension = {
      name: EXT,
      category: 'custom',
      mountStrategy: 'subapp',
      actions: { all: (_input, host) => host.collections.list(C, { limit: 100 }) },
      async register() {},
    };
    const parsed = ManifestSchema.parse({
      name: EXT,
      resources: [RES],
      actions: [
        {
          name: 'all',
          permission: { resource: RES },
          input: { type: 'object' },
          reads: [C],
          writes: [],
        },
      ],
    });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${EXT}, ${EXT}, NULL, true, true, ${toJsonb(parsed)})`.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    const loader = {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
    await finalizeExtensionLoad(
      loader,
      ext,
      EXT,
      `/tmp/${EXT}`,
      app,
      ctx,
      parsed as never,
      new Set(),
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await dropTestCollection(db, C);
  });

  it('applies the update: ciphertext kept, plaintext encrypted, nothing owed after', async () => {
    await applyDeclaredCollections(db, EXT, file('secret'), true);

    const [one, two] = await raw();
    // The field key's ciphertext, byte for byte: re-encrypting it is not needed.
    expect([one!.tok, two!.tok]).toEqual(sealed);
    // Plaintext is ciphertext now, and still the value it was.
    for (const [r, n] of [
      [one!, 1],
      [two!, 2],
    ] as const) {
      expect(r.pin.startsWith('enc:v1:')).toBe(true);
      expect(await decryptField(r.pin)).toBe(`pin-${n}`);
    }

    // The metadata is the file's: no `encrypted`, unique key, index or default.
    const def = await DDLManager.getCollection(db, C);
    const fields = (typeof def?.fields === 'string' ? JSON.parse(def.fields) : def?.fields) as {
      name: string;
      [k: string]: unknown;
    }[];
    for (const name of ['tok', 'pin']) {
      const f = fields.find((x) => x.name === name)!;
      expect(f.type).toBe('secret');
      expect(f.encrypted).toBeUndefined();
      expect(Boolean(f.unique)).toBe(false);
      expect(Boolean(f.indexed)).toBe(false);
      expect(f.defaultValue).toBeUndefined();
    }
    // Nor does the table: no index or unique key names the columns any more.
    const keyed = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
       WHERE i.indrelid = ${`zvd_${C}`}::regclass AND a.attname IN ('tok', 'pin')`.execute(db);
    expect(keyed.rows[0]!.n).toBe(0);

    // A boot or a firm's activation re-plans the same files: nothing is owed.
    expect(await planExtensionSchema(db, EXT, file('secret'))).toEqual([]);
    await applyDeclaredCollections(db, EXT, file('secret'), false);
    await applyDeclaredCollections(db, EXT, file('secret'), true);
    expect((await raw()).map((r) => r.tok)).toEqual(sealed);
  });

  it('the owning extension reads both back through host.collections', async () => {
    const res = await app.request(`/ext/${EXT}/actions/all`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: member.cookie },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const { records } = ((await res.json()) as { result: { records: Record<string, unknown>[] } })
      .result;
    const byId = new Map(records.map((r) => [String(r.id), r]));
    expect(ids.map((id) => [byId.get(id)?.tok, byId.get(id)?.pin])).toEqual([
      ['tok-1', 'pin-1'],
      ['tok-2', 'pin-2'],
    ]);
  });

  it('any other type change is still refused, and changes nothing', async () => {
    await expect(
      applyDeclaredCollections(db, EXT, file('secret', 'integer'), true),
    ).rejects.toThrow(/change field label type text → integer/);
    const def = await DDLManager.getCollection(db, C);
    const fields = (typeof def?.fields === 'string' ? JSON.parse(def.fields) : def?.fields) as {
      name: string;
      type: string;
    }[];
    expect(fields.find((f) => f.name === 'label')?.type).toBe('text');
  });
});
