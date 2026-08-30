/**
 * The planted proof: an extension a firm switched off does not act for that
 * firm — measured against routes registered by the ENGINE'S OWN registration
 * code, with the real registry table deciding.
 *
 * `ext-activation-per-tenant.test.ts` pins the decision and the data model.
 * This one pins that the decision is reached on the way in, because that is the
 * half the previous design got wrong: the marketplace listing honoured
 * `tenant_id` while the loader ignored it, so a firm was shown an extension as
 * absent while its code answered every request. A gate that is not on the path
 * is the same lie with a nicer name.
 *
 * Both mount strategies are planted, because they fail differently:
 *
 *   'subapp'  routes live under /ext/<name>/ — a path gate would have held
 *   'global'  THE DEFAULT: the extension is handed the engine's own app and
 *             registers whatever paths it likes, so a path gate holds nothing
 *
 * The second is why the guard wraps the handle instead of the prefix.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import type { Database } from '../../db/index.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const SUB = `actsub-${STAMP}`;
const GLOB = `actglob-${STAMP}`;
const FIRM_ON = `33333333-3333-4333-8333-${String(STAMP).slice(-12)}`;
const FIRM_OFF = `44444444-4444-4444-8444-${String(STAMP).slice(-12)}`;

d('a firm that switched an extension off is not served by it (in-process)', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    for (const name of [SUB, GLOB]) {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
      // god installs for the instance...
      await sql`
        INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
        VALUES (${name}, ${name}, NULL, true, true)
      `.execute(db);
      // ...and one firm switches it off.
      await sql`
        INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
        VALUES (${name}, ${name}, ${FIRM_OFF}, true, false)
      `.execute(db);
    }
    invalidateActivationCache();
  });

  afterEach(() => {
    invalidateActivationCache();
  });

  /** Register `extension` through the real loader path and return an app that
   *  presents itself as `tenantId`. */
  async function appFor(
    extension: ZveltioExtension,
    name: string,
    tenantId: string,
  ): Promise<Hono> {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenant', { id: tenantId } as never);
      return next();
    });
    const loader = {
      loaded: new Map(),
      modules: new Map<string, ZveltioExtension>(),
      lastLoadError: new Map(),
      ctx: { db } as unknown as ExtensionContext,
    } as unknown as ExtensionLoader;
    await finalizeExtensionLoad(
      loader,
      extension,
      name,
      `/tmp/${name}`,
      app,
      loader.ctx as ExtensionContext,
      { name, version: '1.0.0', category: 'custom' } as never,
      new Set(),
    );
    return app;
  }

  const subappExt = (): ZveltioExtension => ({
    name: SUB,
    category: 'custom',
    mountStrategy: 'subapp',
    async register(sub) {
      sub.get('/hello', (c) => c.text('acted'));
    },
  });

  const globalExt = (): ZveltioExtension => ({
    name: GLOB,
    category: 'custom',
    mountStrategy: 'global',
    async register(hostApp) {
      // Deliberately OUTSIDE /ext/ — which a `mountStrategy: 'global'`
      // extension is free to do, and which is exactly what a path-prefix gate
      // would never have seen.
      hostApp.get('/somewhere-else/ping', (c) => c.text('acted'));
    },
  });

  describe("mountStrategy 'subapp'", () => {
    it('acts for a firm that has it on', async () => {
      const app = await appFor(subappExt(), SUB, FIRM_ON);
      const res = await app.request(`/ext/${SUB}/hello`);
      expect(await res.text()).toBe('acted');
    });

    it('does not act for the firm that switched it off', async () => {
      const app = await appFor(subappExt(), SUB, FIRM_OFF);
      const res = await app.request(`/ext/${SUB}/hello`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toBe('acted');
    });
  });

  describe("mountStrategy 'global' — routes outside /ext/", () => {
    it('acts for a firm that has it on', async () => {
      const app = await appFor(globalExt(), GLOB, FIRM_ON);
      const res = await app.request('/somewhere-else/ping');
      expect(await res.text()).toBe('acted');
    });

    it('does not act for the firm that switched it off', async () => {
      const app = await appFor(globalExt(), GLOB, FIRM_OFF);
      const res = await app.request('/somewhere-else/ping');
      expect(res.status).toBe(404);
      expect(await res.text()).not.toBe('acted');
    });
  });

  it('keeps a chained registration guarded too', async () => {
    // Hono chains by returning the app. If the proxy handed back the raw app,
    // everything after the first `.get()` would register unguarded.
    const ext: ZveltioExtension = {
      name: GLOB,
      category: 'custom',
      mountStrategy: 'global',
      async register(hostApp) {
        hostApp.get('/chain/one', (c) => c.text('acted')).get('/chain/two', (c) => c.text('acted'));
      },
    };
    const app = await appFor(ext, GLOB, FIRM_OFF);
    expect((await app.request('/chain/two')).status).toBe(404);
  });
});
