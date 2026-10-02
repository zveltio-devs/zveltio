/**
 * `ctx.internals.moveToTrash` trashes only a file of the tenant the work runs
 * as — the tenant is the host's, never an argument.
 *
 * The tenant filter in `lib/cloud/trash.ts` was an OPTIONAL fourth argument,
 * and `content/media` calls the three-argument form. Where the row policy on
 * `zv_media_files` does not bind — no tenant transaction (the pool), or an
 * engine whose role bypasses RLS — that argument was the only tenant boundary,
 * so the three-argument call soft-deleted another tenant's file. Measured here
 * before the fix: the no-request case trashed `OTHER`'s file.
 *
 * Driven through the engine's own loader behind the real `/ext/*` chain, the
 * way `content/media` calls it: `moveToTrash(ctx.db, id, user.id)`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext, ExtensionInternals } from '../../lib/extensions/internals.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const SLUG = `trash-${OTHER.slice(0, 8)}`;
const NAME = `trashten-${Date.now()}`;

d('ctx.internals.moveToTrash stays inside the running tenant', () => {
  let db: Database;
  let app: Hono;
  let member: { cookie: string; userId: string };
  let internals: ExtensionInternals;
  let extDb: Database;
  const files: Record<string, string> = {};

  const fileIn = async (tenant: string, label: string) =>
    (
      await sql<{ id: string }>`
        INSERT INTO zv_media_files (filename, original_name, mimetype, storage_path, tenant_id)
        VALUES (${label}, ${label}, 'text/plain', ${label}, ${tenant}::uuid)
        RETURNING id`.execute(db)
    ).rows[0]!.id;
  const trashed = async (id: string) =>
    (
      await sql<{ gone: boolean }>`
        SELECT deleted_at IS NOT NULL AS gone FROM zv_media_files WHERE id = ${id}`.execute(db)
    ).rows[0]!.gone;
  const attempt = (p: Promise<unknown>) =>
    p.then(
      () => 'trashed',
      (err: Error) => err.message,
    );

  beforeAll(async () => {
    let engine: Hono;
    ({ app: engine, db } = await getTestApp());
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    member = await createMemberSession(engine, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    files.rootOwn = await fileIn(ROOT, `${NAME}-root-own`);
    files.otherByRequest = await fileIn(OTHER, `${NAME}-other-req`);
    files.otherNoRequest = await fileIn(OTHER, `${NAME}-other-noreq`);

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${NAME}, ${NAME}, NULL, true, true)`.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    const loader = {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
    const ext: ZveltioExtension = {
      name: NAME,
      category: 'custom',
      mountStrategy: 'subapp',
      async register(sub, ectx) {
        internals = ectx.internals as unknown as ExtensionInternals;
        extDb = ectx.db as unknown as Database;
        // `content/media`'s DELETE /files/:id, minus its own ownership check.
        sub.delete('/files/:id', async (c) => {
          const user = c.get('user' as never) as { id: string };
          return c.json({
            outcome: await attempt(internals.moveToTrash(extDb, c.req.param('id'), user.id)),
          });
        });
      },
    };
    await finalizeExtensionLoad(
      loader,
      ext,
      NAME,
      `/tmp/${NAME}`,
      app,
      ctx,
      { name: NAME, version: '1.0.0', category: 'custom', permissions: ['files'] } as never,
      new Set(['zv_media_files']),
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await sql`DELETE FROM zv_media_files WHERE filename LIKE ${`${NAME}%`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  const del = async (id: string) =>
    (
      (await (
        await app.request(`/ext/${NAME}/files/${id}`, {
          method: 'DELETE',
          headers: { cookie: member.cookie },
        })
      ).json()) as { outcome: string }
    ).outcome;

  it('trashes a file of the request’s own tenant', async () => {
    expect(await del(files.rootOwn!)).toBe('trashed');
    expect(await trashed(files.rootOwn!)).toBe(true);
  });

  it('does not trash another tenant’s file from a request', async () => {
    expect(await del(files.otherByRequest!)).toMatch(/not found/i);
    expect(await trashed(files.otherByRequest!)).toBe(false);
  });

  it('does not trash anything where no tenant runs (load time, a timer)', async () => {
    const outcome = await attempt(internals.moveToTrash(extDb, files.otherNoRequest!, 'system'));
    expect(outcome).not.toBe('trashed');
    expect(await trashed(files.otherNoRequest!)).toBe(false);
  });
});
