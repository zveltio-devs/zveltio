import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { ENGINE_VERSION, getVersionInfo } from '../version.js';
import { getLastAppliedMigration, getAppliedMigrations } from '../db/migrations/index.js';

const startTime = Date.now();

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

export function healthRoutes(db: Database): Hono {
  const app = new Hono();

  // GET /api/health — public, no auth required
  app.get('/', async (c) => {
    const checks: Record<string, boolean> = {};

    // Database check
    try {
      await (db as any).selectFrom('user').select('id').limit(1).execute();
      checks.database = true;
    } catch {
      checks.database = false;
    }

    const schemaVersion = await getLastAppliedMigration(db).catch(() => 0);
    const versionInfo = getVersionInfo(schemaVersion);
    const allHealthy = Object.values(checks).every(Boolean);

    return c.json(
      {
        status: allHealthy ? 'ok' : 'degraded',
        ...versionInfo,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        checks,
        timestamp: new Date().toISOString(),
      },
      allHealthy ? 200 : 503,
    );
  });

  // GET /api/health/version — detailed version info
  app.get('/version', async (c) => {
    const schemaVersion = await getLastAppliedMigration(db).catch(() => 0);
    return c.json(getVersionInfo(schemaVersion));
  });

  // GET /api/health/migrations — migration status (no auth — status info only)
  app.get('/migrations', async (c) => {
    const migrations = await getAppliedMigrations(db);
    return c.json({ migrations, total: migrations.length });
  });

  // GET /api/health/update-check — check for new engine release
  app.get('/update-check', async (c) => {
    try {
      const res = await fetch(
        'https://api.github.com/repos/zveltio-devs/zveltio/releases/latest',
        {
          headers: { 'User-Agent': 'zveltio-engine' },
          signal: AbortSignal.timeout(5000),
        },
      );

      if (!res.ok) throw new Error('GitHub API unavailable');

      const release = (await res.json()) as any;
      const latestVersion = release.tag_name?.replace('v', '') ?? ENGINE_VERSION;
      const hasUpdate = compareVersions(latestVersion, ENGINE_VERSION) > 0;

      return c.json({
        current: ENGINE_VERSION,
        latest: latestVersion,
        has_update: hasUpdate,
        release_url: release.html_url,
        release_notes: release.body?.slice(0, 500) ?? '',
        published_at: release.published_at,
      });
    } catch {
      return c.json({
        current: ENGINE_VERSION,
        latest: null,
        has_update: false,
        error: 'Could not check for updates',
      });
    }
  });

  return app;
}
