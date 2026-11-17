/**
 * An API key survives a `BETTER_AUTH_SECRETS` rotation (ADR 0058 decision 7, DR-17).
 *
 * A key's stored hash is an HMAC under the auth secret, and the lookup hashed
 * the presented key under the current secret only: making a new secret current
 * answered 401 for every key, though the old secret was still listed. Now the
 * lookup tries every held secret, and a key found under one that is not current
 * is rewritten under the current one, with its version (migration 126). So a
 * key used once after the rotation outlives its old secret; a key never used
 * since does not.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, createSteppedUpGod, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = `keyrot-${crypto.randomUUID().slice(0, 8)}`;
const OLD = `old-${'o'.repeat(40)}`;
const NEW = `new-${'n'.repeat(40)}`;

async function hmac(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return Buffer.from(sig).toString('hex');
}

d('API keys across a BETTER_AUTH_SECRETS rotation (DR-17)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const saved = process.env.BETTER_AUTH_SECRETS;

  const mint = async (path: string) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: NAME, scopes: [{ collection: '$schema', actions: ['read'] }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; key: string; key_hash_version?: unknown };
    return { id: body.id, key: body.key };
  };
  const status = async (key: string) =>
    (await app.request('/api/collections', { headers: { 'X-API-Key': key } })).status;
  const row = async (id: string) =>
    (
      await sql<{ key_hash: string; key_hash_version: number | null }>`
        SELECT key_hash, key_hash_version FROM zv_api_keys WHERE id = ${id}::uuid`.execute(db)
    ).rows[0]!;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    const god = await createSteppedUpGod(app, db);
    ({ app, cookie } = god);
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.BETTER_AUTH_SECRETS;
    else process.env.BETTER_AUTH_SECRETS = saved;
    await sql`DELETE FROM zv_api_keys WHERE name = ${NAME}`.execute(db).catch(() => {});
  });

  it('a key used after the rotation is rewritten and outlives its old secret; an unused one does not', async () => {
    process.env.BETTER_AUTH_SECRETS = `1:${OLD}`;
    // Both doors that mint a key record the version that wrote its hash.
    const used = await mint('/api/api-keys');
    const unused = await mint('/api/admin/api-keys');
    for (const k of [used, unused]) {
      expect(await row(k.id)).toEqual({ key_hash: await hmac(OLD, k.key), key_hash_version: 1 });
    }
    expect(await status(used.key)).toBe(200);

    // Phase 2: <new> is current, <old> still listed.
    process.env.BETTER_AUTH_SECRETS = `2:${NEW},1:${OLD}`;
    expect(await status(used.key)).toBe(200);
    const want = { key_hash: await hmac(NEW, used.key), key_hash_version: 2 };
    // The rewrite is not awaited by the request (lib/data/auth.ts `rehashApiKey`).
    for (let i = 0; i < 50 && (await row(used.id)).key_hash_version !== 2; i++) {
      await Bun.sleep(20);
    }
    expect(await row(used.id)).toEqual(want);
    expect(await row(unused.id)).toEqual({
      key_hash: await hmac(OLD, unused.key),
      key_hash_version: 1,
    });

    // Phase 3: <old> leaves the list.
    process.env.BETTER_AUTH_SECRETS = `2:${NEW}`;
    expect(await status(used.key)).toBe(200);
    expect(await status(unused.key)).toBe(401);
  });
});
