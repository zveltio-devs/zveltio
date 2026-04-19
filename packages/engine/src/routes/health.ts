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

export function healthRoutes(db: Database, auth?: any): Hono {
  const app = new Hono();

  // Auth guard for detail endpoints — `/` stays public (minimal response).
  // If `auth` wasn't passed (tests, some older call-sites), fall through so
  // behaviour matches the previous shape instead of 401-ing every request.
  async function requireAuth(c: any): Promise<boolean> {
    if (!auth) return true;
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      return !!session;
    } catch {
      return false;
    }
  }

  // GET /api/health — public, no auth required.
  // Minimal response — never leak engine/schema/runtime info here. Details live
  // behind /version, which is authenticated. See security sprint notes.
  app.get('/', async (c) => {
    let databaseOk = true;
    try {
      await (db as any).selectFrom('user').select('id').limit(1).execute();
    } catch {
      databaseOk = false;
    }

    return c.json(
      {
        status: databaseOk ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
      },
      databaseOk ? 200 : 503,
    );
  });

  // GET /api/health/version — detailed version info (auth-gated).
  app.get('/version', async (c) => {
    if (!(await requireAuth(c))) return c.json({ error: 'Unauthorized' }, 401);
    const schemaVersion = await getLastAppliedMigration(db).catch(() => 0);
    return c.json(getVersionInfo(schemaVersion));
  });

  // GET /api/health/migrations — migration status (auth-gated).
  app.get('/migrations', async (c) => {
    if (!(await requireAuth(c))) return c.json({ error: 'Unauthorized' }, 401);
    const migrations = await getAppliedMigrations(db);
    return c.json({ migrations, total: migrations.length });
  });

  // GET /api/health/update-check — check for new engine release (auth-gated).
  app.get('/update-check', async (c) => {
    if (!(await requireAuth(c))) return c.json({ error: 'Unauthorized' }, 401);
    try {
      // Use /releases (not /releases/latest) so pre-release channels (alpha/beta)
      // are included in the update check.
      const res = await fetch(
        'https://api.github.com/repos/zveltio-devs/zveltio/releases?per_page=1',
        {
          headers: { 'User-Agent': 'zveltio-engine' },
          signal: AbortSignal.timeout(5000),
        },
      );

      if (!res.ok) throw new Error('GitHub API unavailable');

      const releases = (await res.json()) as any[];
      const release = releases[0];
      const latestVersion = release?.tag_name?.replace('v', '') ?? ENGINE_VERSION;
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
