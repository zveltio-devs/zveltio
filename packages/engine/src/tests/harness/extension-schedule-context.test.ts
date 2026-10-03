/**
 * An extension's schedule handler gets the same restricted context as its
 * routes: `ctx.db` table-guarded and `ctx.internals` capability-gated.
 *
 * `index.ts` starts the cron runner with ONE base context — the raw pool and
 * `buildExtensionInternals()` unwrapped — and the runner handed that to every
 * extension's `handler(ctx, runId)`. So a schedule of an extension declaring
 * nothing read `"user"`, decrypted secrets and entered any tenant: everything
 * `buildRestrictedContext` withholds from the same extension's routes.
 *
 * The handler is called exactly as `CronRunnerImpl._runOne` calls it, with the
 * base context `index.ts` builds.
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
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { cronRunner } from '../../lib/runtime/index.js';
import type { ExtensionSchedule } from '../../lib/runtime/cron-runner.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = `schedctx-${Date.now()}`;
const OTHER = crypto.randomUUID();

d('an extension schedule runs with its own restricted context', () => {
  let db: Database;
  let probed: Record<string, string> = {};
  const inlineBefore = process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;

  /** What each reach answered: `ok`, or the error's name. */
  const attempt = async (fn: () => unknown) => {
    try {
      await fn();
      return 'ok';
    } catch (err) {
      return (err as Error).message.includes('tenant:enter') ? 'tenant:enter' : (err as Error).name;
    }
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
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
      async register() {},
      schedules: () => [
        {
          name: 'probe',
          intervalMs: 3_600_000,
          async handler(sctx) {
            const c = sctx as unknown as ExtensionContext;
            probed = {
              userTable: await attempt(() => c.db.selectFrom('user').select('id').execute()),
              secrets: await attempt(() => c.internals.decryptSecret('x')),
              otherTenant: await attempt(() =>
                c.internals.withTenantIsolation(OTHER, async () => 1),
              ),
            };
          },
        },
      ],
    };
    await finalizeExtensionLoad(
      loader,
      ext,
      NAME,
      `/tmp/${NAME}`,
      new Hono(),
      ctx,
      { name: NAME, version: '1.0.0', category: 'custom', permissions: [] } as never,
      new Set(),
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    if (inlineBefore === undefined) delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
    else process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = inlineBefore;
    cronRunner.unregisterAll(NAME);
    invalidateActivationCache();
    if (db) await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
  });

  it('a no-capability schedule cannot reach engine tables, secrets or another tenant', async () => {
    const entries = (
      cronRunner as unknown as { entries: Map<string, { schedule: ExtensionSchedule }> }
    ).entries;
    const entry = entries.get(`${NAME}::probe`);
    expect(entry).toBeDefined();
    // The base context `index.ts` hands `cronRunner.start`.
    const base = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    await entry!.schedule.handler(base, crypto.randomUUID());
    expect(probed).toEqual({
      userTable: 'ExtensionSecurityError',
      secrets: 'CapabilityDeniedError',
      otherTenant: 'tenant:enter',
    });
  });

  it('does not run at all once no firm has the extension on', async () => {
    const entries = (
      cronRunner as unknown as { entries: Map<string, { schedule: ExtensionSchedule }> }
    ).entries;
    await sql`UPDATE zv_extension_registry SET is_enabled = false WHERE name = ${NAME}`.execute(db);
    probed = {};
    const base = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    await entries.get(`${NAME}::probe`)!.schedule.handler(base, crypto.randomUUID());
    expect(probed).toEqual({});
  });
});
