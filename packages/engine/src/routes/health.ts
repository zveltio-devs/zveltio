import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { ENGINE_VERSION, getVersionInfo } from '../version.js';
import { getLastAppliedMigration, getAppliedMigrations } from '../db/migrations/index.js';
import { getCache } from '../lib/runtime/index.js';

interface CheckResult {
  ok: boolean;
  durationMs: number;
  error?: string;
}

async function timed(fn: () => Promise<void>): Promise<CheckResult> {
  const t0 = performance.now();
  try {
    await fn();
    return { ok: true, durationMs: performance.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      durationMs: performance.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export function healthRoutes(db: Database, auth?: any): Hono {
  const app = new Hono();

  // Auth guard for detail endpoints — `/` stays public (minimal response).
  // If `auth` wasn't passed (tests, some older call-sites), fall through so
  // behaviour matches the previous shape instead of 401-ing every request.
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
  //
  // Exception: `demo_mode` is exposed publicly so the Studio can render a
  // demo banner + show the throwaway credentials on the login page. This
  // is intentional — there is no security value in hiding the fact that an
  // engine is in demo mode (the banner itself advertises it).
  app.get('/', async (c) => {
    let databaseOk = true;
    try {
      await db.selectFrom('user').select('id').limit(1).execute();
    } catch {
      databaseOk = false;
    }

    const demoMode = process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1';

    // Guardrail: an operator who left DEMO_MODE=true in a production
    // .env would otherwise publish disposable credentials to the world
    // via the unauthenticated /api/health endpoint. Refuse to surface
    // demo credentials when NODE_ENV=production AND
    // DEMO_MODE_ALLOW_IN_PROD isn't explicitly set. The banner still
    // shows ("demo_mode: true"), so the misconfiguration is visible —
    // we just don't hand out the passwords.
    const inProd = process.env.NODE_ENV === 'production';
    const demoInProdAllowed = process.env.DEMO_MODE_ALLOW_IN_PROD === 'true';
    const exposeCreds = demoMode && (!inProd || demoInProdAllowed);

    return c.json(
      {
        status: databaseOk ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        demo_mode: demoMode,
        demo_reset_cron: demoMode ? (process.env.DEMO_RESET_CRON ?? null) : undefined,
        demo_credentials: exposeCreds
          ? {
              email: process.env.DEMO_EMAIL ?? 'demo@zveltio.com',
              // We intentionally surface the password — demo accounts must be
              // disposable. Never run with this enabled on real data.
              password: process.env.DEMO_PASSWORD ?? 'demo123456',
            }
          : undefined,
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

  // GET /api/health/ready — kubernetes-style readiness probe.
  // Returns 200 only when every hard dependency required to serve traffic is up.
  // Use this in load balancers / k8s `readinessProbe`. Different from `/` which
  // is a liveness probe (process alive). Public, no auth — k8s can't auth.
  app.get('/ready', async (c) => {
    const checks: Record<string, CheckResult> = {};

    checks.database = await timed(async () => {
      await db.selectFrom('user').select('id').limit(1).execute();
    });

    checks.migrations = await timed(async () => {
      const last = await getLastAppliedMigration(db);
      if (last < 1) throw new Error('no migrations applied');
    });

    checks.cache = await timed(async () => {
      const cache = getCache();
      if (!cache) return; // cache is optional — treat as "ok" if unconfigured
      const pong = await cache.ping();
      if (pong !== 'PONG') throw new Error(`unexpected ping reply: ${pong}`);
    });

    const allOk = Object.values(checks).every((c) => c.ok);
    return c.json({ status: allOk ? 'ok' : 'degraded', checks }, allOk ? 200 : 503);
  });

  // GET /api/health/deep — comprehensive diagnostic for operators.
  // Auth-gated. Includes everything in /ready plus disk + extension loader
  // state. Use this from a status page or oncall runbook, not from a probe.
  app.get('/deep', async (c) => {
    if (!(await requireAuth(c))) return c.json({ error: 'Unauthorized' }, 401);

    const checks: Record<string, CheckResult> = {};

    checks.database = await timed(async () => {
      await db.selectFrom('user').select('id').limit(1).execute();
    });

    checks.migrations = await timed(async () => {
      const last = await getLastAppliedMigration(db);
      if (last < 1) throw new Error('no migrations applied');
    });

    checks.cache = await timed(async () => {
      const cache = getCache();
      if (!cache) return;
      const pong = await cache.ping();
      if (pong !== 'PONG') throw new Error(`unexpected ping reply: ${pong}`);
    });

    checks.backup_dir = await timed(async () => {
      const dir = process.env.BACKUP_DIR ?? '/tmp/zveltio-backups';
      // Write a tiny canary file and remove it — proves write access.
      const canary = `${dir}/.health-probe-${Date.now()}`;
      await Bun.write(canary, 'ok');
      await Bun.spawn(['rm', '-f', canary]).exited;
    });

    checks.storage_dir = await timed(async () => {
      const dir = process.env.STORAGE_DIR;
      if (!dir) return; // S3 or unconfigured — skip
      const canary = `${dir}/.health-probe-${Date.now()}`;
      await Bun.write(canary, 'ok');
      await Bun.spawn(['rm', '-f', canary]).exited;
    });

    const allOk = Object.values(checks).every((c) => c.ok);
    return c.json(
      {
        status: allOk ? 'ok' : 'degraded',
        version: ENGINE_VERSION,
        timestamp: new Date().toISOString(),
        checks,
      },
      allOk ? 200 : 503,
    );
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

      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
