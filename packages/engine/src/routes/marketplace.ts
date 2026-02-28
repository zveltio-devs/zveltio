import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/casbin.js';
import { EXTENSION_CATALOG } from '../lib/extension-catalog.js';
import { extensionLoader } from '../lib/extension-loader.js';

export function marketplaceRoutes(db: Database, app: Hono): Hono {
  const router = new Hono();

  // Admin-only guard
  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    const isAdmin = await checkPermission(session.user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin required' }, 403);
    await next();
  });

  // GET /api/marketplace — catalog merged with DB state + runtime state
  router.get('/', async (c) => {
    const rows = await (db as any)
      .selectFrom('zv_extension_registry')
      .selectAll()
      .execute()
      .catch(() => []);

    const dbMap = new Map(rows.map((r: any) => [r.name, r]));

    const extensions = EXTENSION_CATALOG.map((entry) => {
      const dbEntry = dbMap.get(entry.name) as any;
      const runtimeActive = extensionLoader.isActive(entry.name);

      return {
        ...entry,
        is_installed: dbEntry?.is_installed ?? runtimeActive,
        is_enabled:   dbEntry?.is_enabled   ?? runtimeActive,
        is_running:   runtimeActive,
        needs_restart: (dbEntry?.is_enabled && !runtimeActive) ||
                       (!dbEntry?.is_enabled && runtimeActive && dbEntry !== undefined),
        config:       dbEntry?.config ?? {},
        installed_at: dbEntry?.installed_at ?? null,
        enabled_at:   dbEntry?.enabled_at   ?? null,
      };
    });

    return c.json({ extensions });
  });

  // POST /api/marketplace/:name/install
  router.post('/:name{.+}/install', async (c) => {
    const name = c.req.param('name');
    const entry = EXTENSION_CATALOG.find((e) => e.name === name);
    if (!entry) return c.json({ error: 'Extension not found in catalog' }, 404);
    if (!entry.bundled) return c.json({ error: 'External install not yet supported' }, 501);

    await (db as any)
      .insertInto('zv_extension_registry')
      .values({
        name:         entry.name,
        display_name: entry.displayName,
        description:  entry.description,
        category:     entry.category,
        version:      entry.version,
        author:       entry.author,
        is_installed: true,
        is_enabled:   false,
        installed_at: new Date(),
      })
      .onConflict((oc: any) =>
        oc.column('name').doUpdateSet({
          is_installed: true,
          installed_at: new Date(),
        }),
      )
      .execute();

    return c.json({
      success: true,
      message: `Extension ${name} installed. Enable it to activate.`,
    });
  });

  // POST /api/marketplace/:name/enable
  router.post('/:name{.+}/enable', async (c) => {
    const name = c.req.param('name');
    const entry = EXTENSION_CATALOG.find((e) => e.name === name);
    if (!entry) return c.json({ error: 'Extension not found in catalog' }, 404);

    await (db as any)
      .insertInto('zv_extension_registry')
      .values({
        name:         entry.name,
        display_name: entry.displayName,
        description:  entry.description,
        category:     entry.category,
        version:      entry.version,
        author:       entry.author,
        is_installed: true,
        is_enabled:   true,
        installed_at: new Date(),
        enabled_at:   new Date(),
      })
      .onConflict((oc: any) =>
        oc.column('name').doUpdateSet({
          is_installed: true,
          is_enabled:   true,
          enabled_at:   new Date(),
        }),
      )
      .execute();

    // Attempt hot-load
    let hotLoaded = false;
    if (!extensionLoader.isActive(name)) {
      try {
        await extensionLoader.loadDynamic(name, app);
        hotLoaded = true;
      } catch (e) {
        console.warn(`Hot-load failed for ${name}:`, e);
      }
    } else {
      hotLoaded = true;
    }

    return c.json({
      success: true,
      hot_loaded:    hotLoaded,
      needs_restart: !hotLoaded,
      message: hotLoaded
        ? `Extension ${name} is now active.`
        : `Extension ${name} will be active after restart.`,
    });
  });

  // POST /api/marketplace/:name/disable
  router.post('/:name{.+}/disable', async (c) => {
    const name = c.req.param('name');

    await (db as any)
      .insertInto('zv_extension_registry')
      .values({
        name,
        display_name: name,
        category:     'custom',
        version:      '1.0.0',
        author:       '',
        is_installed: true,
        is_enabled:   false,
      })
      .onConflict((oc: any) =>
        oc.column('name').doUpdateSet({ is_enabled: false }),
      )
      .execute();

    const isRunning = extensionLoader.isActive(name);

    return c.json({
      success:       true,
      needs_restart: isRunning,
      message: isRunning
        ? `Extension ${name} will be disabled after restart.`
        : `Extension ${name} is disabled.`,
    });
  });

  // PUT /api/marketplace/:name/config
  router.put('/:name{.+}/config', async (c) => {
    const name = c.req.param('name');
    const config = await c.req.json();

    await (db as any)
      .insertInto('zv_extension_registry')
      .values({
        name,
        display_name: name,
        category:     'custom',
        version:      '1.0.0',
        author:       '',
        is_installed: true,
        is_enabled:   false,
        config,
      })
      .onConflict((oc: any) =>
        oc.column('name').doUpdateSet({ config }),
      )
      .execute();

    return c.json({ success: true });
  });

  // POST /api/marketplace/:name/uninstall
  router.post('/:name{.+}/uninstall', async (c) => {
    const name = c.req.param('name');

    await (db as any)
      .deleteFrom('zv_extension_registry')
      .where('name' as any, '=', name)
      .execute();

    return c.json({
      success:       true,
      needs_restart: extensionLoader.isActive(name),
      message:       `Extension ${name} uninstalled.`,
    });
  });

  return router;
}
