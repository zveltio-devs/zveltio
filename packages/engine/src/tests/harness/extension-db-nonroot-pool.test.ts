/**
 * An inline extension's `ctx.db` with no transaction open falls back to the
 * pool only where no tenant other than the root one is in play.
 *
 * The async context can name a firm and hold no transaction: a route the tenant
 * middleware opens none for (`TXN_SKIP_PREFIXES`), and the outer context an
 * `onAfterCommit` job runs in. There the pool used to answer, and an insert
 * written on behalf of firm B took the column default — the root firm.
 * Measured here before the fix: both B rows below landed in ROOT.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { _resetExtensionDbRoleForTests } from '../../lib/extensions/ext-db-role.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext, ExtensionInternals } from '../../lib/extensions/internals.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { onAfterCommit } from '../../lib/tenancy/index.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const SLUG = `nrp-${OTHER.slice(0, 8)}`;
const STAMP = `nonroot_pool_${Date.now()}`;
const EXT = `nonroot-pool-${Date.now()}`;

d('ctx.db outside a transaction under a non-root firm', () => {
  let db: Database;
  let app: Hono;
  let extDb: Database;
  let internals: ExtensionInternals;
  let job: Promise<unknown> = Promise.resolve();

  /** Insert one row through the extension's `ctx.db`; the error message on refusal. */
  // The refusal throws at the first property read, so the chain starts in a `then`.
  const write = (name: string) =>
    Promise.resolve()
      .then(() =>
        extDb
          .insertInto('zv_dashboards' as never)
          .values({ name: `${STAMP}_${name}`, is_public: true } as never)
          .execute(),
      )
      .then(
        () => 'written',
        (err: Error) => err.message,
      );
  const landedIn = async (name: string) =>
    (
      await sql<{ tenant_id: string }>`
        SELECT tenant_id FROM zv_dashboards WHERE name = ${`${STAMP}_${name}`}`.execute(db)
    ).rows.map((r) => r.tenant_id);

  beforeAll(async () => {
    _resetExtensionDbRoleForTests();
    ({ db } = await getTestApp());
    _setInlineForTests(true);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${EXT}, ${EXT}, NULL, true, true)`.execute(db);
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
      name: EXT,
      category: 'custom',
      mountStrategy: 'subapp',
      async register(_sub, ectx) {
        extDb = ectx.db as unknown as Database;
        internals = ectx.internals as unknown as ExtensionInternals;
      },
    };
    await finalizeExtensionLoad(
      loader,
      ext,
      EXT,
      `/tmp/${EXT}`,
      new Hono(),
      ctx,
      { name: EXT, version: '1.0.0', category: 'custom', permissions: [] } as never,
      new Set(['zv_dashboards']),
    );
    invalidateActivationCache();

    app = new Hono();
    app.use('/api/*', tenantMiddleware);
    // `/api/health` is in TXN_SKIP_PREFIXES: the firm is the domain, no transaction.
    app.get('/api/health/nrp/:name', async (c) => c.json({ r: await write(c.req.param('name')) }));
    // A transaction route whose after-commit job reaches for ctx.db.
    app.get('/api/nrp-after/:name', (c) => {
      const name = c.req.param('name');
      onAfterCommit(() => {
        job = write(name);
      });
      return c.json({ queued: true });
    });
    // The remedy: a short tenant transaction around the work.
    app.get('/api/health/nrp-scoped', async (c) => {
      const tenant = c.get('tenant') as { id: string };
      await internals.withTenantIsolation(tenant.id, (trx) =>
        trx
          .insertInto('zv_dashboards' as never)
          .values({ name: `${STAMP}_scoped`, is_public: true } as never)
          .execute(),
      );
      return c.json({ ok: true });
    });
  }, 60_000);

  afterAll(async () => {
    _setInlineForTests(false);
    invalidateActivationCache();
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await sql`DELETE FROM zv_dashboards WHERE name LIKE ${`${STAMP}_%`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  const ask = async (path: string, slug?: string) =>
    (await app.request(path, { headers: slug ? { 'x-tenant-slug': slug } : {} })).json();

  it('refuses on a no-transaction route of another firm instead of writing into root', async () => {
    const { r } = await ask('/api/health/nrp/skip', SLUG);
    expect(await landedIn('skip')).toEqual([]);
    expect(r).toContain('no tenant transaction is open here');
  });

  it('refuses in an after-commit job of another firm instead of writing into root', async () => {
    expect(await ask('/api/nrp-after/after', SLUG)).toEqual({ queued: true });
    await Bun.sleep(50);
    const r = await job;
    expect(await landedIn('after')).toEqual([]);
    expect(r).toContain('no tenant transaction is open here');
  });

  it('the remedy works there: a short withTenantIsolation lands the row in the firm', async () => {
    expect(await ask('/api/health/nrp-scoped', SLUG)).toEqual({ ok: true });
    expect(await landedIn('scoped')).toEqual([OTHER]);
  });

  it('keeps the pool for the root firm and outside any tenant context', async () => {
    expect((await ask('/api/health/nrp/root')).r).toBe('written');
    expect(await landedIn('root')).toEqual([ROOT]);
    expect(await write('boot')).toBe('written');
    expect(await landedIn('boot')).toEqual([ROOT]);
  });
});
