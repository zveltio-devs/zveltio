import { writeFileSync, unlinkSync } from 'node:fs';
import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { ENGINE_VERSION, getVersionInfo } from '../version.js';
import { getLastAppliedMigration, getAppliedMigrations } from '../db/migrations/index.js';
import { getCache, realtimeBus } from '../lib/runtime/index.js';
import { isDDLQueueStarted } from '../lib/data/index.js';
import { extensionLoader } from '../lib/extensions/index.js';
import {
  type HealthCheck,
  getHealthCheck,
  listHealthChecks,
  runHealthCheck,
} from '../lib/health-registry.js';

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

  // GET /api/health/ready — kubernetes-style readiness probe. Public (k8s can't
  // auth). Runs ONLY the CRITICAL subsystems from the deep-health model (db,
  // migrations) — an optional dependency being down (Valkey, queue) leaves the
  // instance READY so the load balancer keeps routing while it degrades. Use
  // `/api/health/deep` for the full picture.
  app.get('/ready', async (c) => {
    const checks: Record<string, unknown> = {};
    let ok = true;
    for (const check of coreChecks().filter((ch) => ch.critical)) {
      const r = await runHealthCheck(check);
      checks[check.name] = r;
      if (!r.ok) ok = false;
    }
    return c.json({ status: ok ? 'ok' : 'unhealthy', checks }, ok ? 200 : 503);
  });

  // ── Deep-health subsystem model (H-1.4) ─────────────────────────────────
  // Every subsystem the engine depends on, each with a `critical` flag: a
  // failing critical check (db/migrations) means the engine can't serve; a
  // failing non-critical one means DEGRADED (a Valkey/queue/storage blip). Core
  // checks live here (they need `db`); extension-contributed checks
  // (`ctx.onHealthCheck`) come from the health-registry.
  function coreChecks(): HealthCheck[] {
    return [
      {
        name: 'database',
        critical: true,
        run: async () => {
          await db.selectFrom('user').select('id').limit(1).execute();
          return { ok: true };
        },
      },
      {
        name: 'migrations',
        critical: true,
        run: async () => {
          const last = await getLastAppliedMigration(db);
          return {
            ok: last >= 1,
            detail: { applied: last },
            error: last < 1 ? 'no migrations applied' : undefined,
          };
        },
      },
      {
        name: 'cache',
        critical: false,
        run: async () => {
          const cache = getCache();
          if (!cache) return { ok: true, detail: { configured: false } };
          const pong = await cache.ping();
          return {
            ok: pong === 'PONG',
            detail: { backend: 'valkey' },
            error: pong === 'PONG' ? undefined : `unexpected ping: ${pong}`,
          };
        },
      },
      {
        name: 'queue',
        critical: false,
        run: () => {
          const started = isDDLQueueStarted();
          return {
            ok: started,
            detail: { worker: 'pg-boss', started },
            error: started ? undefined : 'DDL queue worker not started',
          };
        },
      },
      {
        name: 'realtime',
        critical: false,
        run: () => {
          const bus = realtimeBus();
          // pg-notify + none are always-available fallbacks (a single-instance
          // deployment is fine without cross-instance fanout). Only a configured
          // Valkey bus that isn't running is a real problem.
          const ok = bus.backend === 'valkey' ? bus.isRunning : true;
          return {
            ok,
            detail: { backend: bus.backend, running: bus.isRunning },
            error: ok ? undefined : 'valkey realtime bus not running',
          };
        },
      },
      {
        name: 'storage',
        critical: false,
        run: async () => {
          const dir = process.env.STORAGE_DIR;
          if (dir) {
            const canary = `${dir}/.health-probe-${Date.now()}`;
            writeFileSync(canary, 'ok');
            unlinkSync(canary);
            return { ok: true, detail: { backend: 'local', dir } };
          }
          const endpoint = process.env.S3_ENDPOINT;
          if (endpoint) {
            const res = await fetch(endpoint, {
              method: 'HEAD',
              signal: AbortSignal.timeout(3000),
            });
            // Any HTTP reply (even 403) proves reachability; a network throw does not.
            return { ok: true, detail: { backend: 's3', endpoint, status: res.status } };
          }
          return { ok: true, detail: { configured: false } };
        },
      },
      {
        name: 'extensions',
        critical: false,
        run: () => {
          const active = extensionLoader.getActive();
          const failed = [...extensionLoader.lastLoadError.entries()].map(([name, error]) => ({
            name,
            error,
          }));
          return { ok: failed.length === 0, detail: { active: active.length, failed } };
        },
      },
    ];
  }

  const allChecks = (): HealthCheck[] => [...coreChecks(), ...listHealthChecks()];

  // GET /api/health/deep — comprehensive diagnostic for operators. Auth-gated.
  // 200 only when EVERY subsystem is healthy; 503 otherwise. `criticalOk` lets
  // a status page distinguish "degraded (optional dep down)" from "down".
  app.get('/deep', async (c) => {
    if (!(await requireAuth(c))) return c.json({ error: 'Unauthorized' }, 401);

    const checks: Record<string, unknown> = {};
    let allOk = true;
    let criticalOk = true;
    for (const check of allChecks()) {
      const r = await runHealthCheck(check);
      checks[check.name] = { critical: check.critical, ...r };
      if (!r.ok) {
        allOk = false;
        if (check.critical) criticalOk = false;
      }
    }
    return c.json(
      {
        status: allOk ? 'ok' : criticalOk ? 'degraded' : 'unhealthy',
        criticalOk,
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

  // GET /api/health/:subsystem — probe one subsystem (db, migrations, cache,
  // queue, realtime, storage, extensions, or any extension check). Registered
  // LAST so the static health routes above win over this param route.
  app.get('/:subsystem', async (c) => {
    if (!(await requireAuth(c))) return c.json({ error: 'Unauthorized' }, 401);
    const name = c.req.param('subsystem');
    const check = allChecks().find((ch) => ch.name === name) ?? getHealthCheck(name);
    if (!check) return c.json({ error: `Unknown subsystem '${name}'` }, 404);
    const r = await runHealthCheck(check);
    return c.json({ subsystem: name, critical: check.critical, ...r }, r.ok ? 200 : 503);
  });

  return app;
}
