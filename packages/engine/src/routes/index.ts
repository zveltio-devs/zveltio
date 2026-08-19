import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { collectionsRoutes } from './collections.js';
import { dataRoutes } from './data.js';
import { authRoutes, invitationRoutes } from './auth.js';
import { revokeAllUserSessions } from '../lib/auth.js';
import { usersRoutes } from './users.js';
import { permissionsRoutes } from './permissions.js';
import { rlsRoutes } from './rls.js';
import { rpcRoutes } from './rpc.js';
import { storageRoutes } from './storage.js';
import { filesRoutes } from './files.js';
import { webhooksRoutes } from './webhooks.js';
import { isRegistrationEnabled, settingsRoutes } from './settings.js';
import { adminRoutes, apiKeysRoutes } from './admin.js';
import { wsRoutes } from './ws.js';
import { relationsRoutes } from './relations.js';
import { revisionsRoutes } from './revisions.js';
import { realtimeRoutes } from './realtime.js';
import { notificationsRoutes } from './notifications.js';
import { healthRoutes } from './health.js';
import { flowsRoutes } from './flows.js';
import { tenantsRoutes } from './tenants.js';
// AI routes moved to the `ai` extension (zveltio-extensions/ai). It registers
// /api/ai*, /api/zveltio-ai, and /api/ai-analytics from there.
import { approvalsRoutes } from './approvals.js';
import { exportRoutes } from './export.js';
import { importRoutes } from './import.js';
// graphql → extensions/developer/graphql
// drafts → extensions/content/drafts
// documents → extensions/content/documents
import { mediaRoutes } from './media.js';
import { syncRoutes } from './sync.js';
import { electricRoutes } from './electric.js';
import { openApiRoutes } from './openapi.js';
import { edgeFunctionsRoutes, edgeFunctionInvokeRoutes } from './edge-functions.js';
// Promoted-to-core (was extensions/) — these power admin UI pages that should
// work out of the box on a fresh install instead of requiring marketplace install.
import { backupRoutes } from './backup.js';
import { savedQueriesRoutes } from './saved-queries.js';
import { schemaBranchesRoutes } from './schema-branches.js';
import { insightsRoutes } from './insights.js';
import { briefingRoutes } from './briefing.js';
import { sqlEditorRoutes } from './sql-editor.js';
import { templatesRoutes } from './templates.js';
import { erdLayoutRoutes } from './erd-layout.js';
import { initDDLQueue } from '../lib/data/index.js';
import { ensureCoreCollections } from '../core-collections/index.js';
import {
  authRateLimit,
  publicFormRateLimit,
  scimRateLimit,
  shareLinkRateLimit,
  apiRateLimit,
  aiRateLimit,
  writeRateLimit,
  destructiveRateLimit,
  filesRateLimit,
  initRateLimitDb,
} from '../middleware/rate-limit.js';
import { tenantQuota } from '../middleware/tenant-quota.js';
import { slowQueryMiddleware } from '../middleware/slow-query.js';
import { godAuditMiddleware } from '../middleware/god-audit.js';
import { requestLogMiddleware } from '../middleware/request-log.js';
import { previewEnvMiddleware } from '../middleware/preview-env.js';
import { tracingMiddleware } from '../middleware/tracing.js';
import { demoModeMiddleware } from '../middleware/demo-mode.js';

// ── Core routes (always registered) ─────────────────────────────────────────
// /api/flows         — automation flows (routes/flows.ts)
// /api/tenants       — multi-tenancy (routes/tenants.ts)
// /api/ai/*          — AI: providers, chat, embeddings, search, alchemist, query, schema-gen
// /api/zveltio-ai    — ZveltioAI conversational agent
// /api/ai-analytics  — AI usage & cost tracking
//
// ── Extension routes (registered by extension on load) ───────────────────────
// /api/mail             → extensions/communications/mail
// /api/cloud + /share   → extensions/storage/cloud
// /api/pages            → extensions/content/page-builder
// /api/document-templates → extensions/content/document-templates
// /api/documents        → extensions/content/documents
// /api/approvals        → extensions/workflow/approvals
// /api/drafts           → extensions/content/drafts
// /api/media            → extensions/content/media
// /api/graphql          → extensions/developer/graphql
// /api/insights         → extensions/analytics/insights
// /api/quality          → extensions/analytics/quality
// /api/saved-queries    → extensions/developer/saved-queries
// /api/validation       → extensions/developer/validation
// /api/export           → extensions/data/export
// /api/import           — data import CSV/JSON/NDJSON (routes/import.ts)
//
// `/api/translations` is NOT in this list, and its absence is the point. The
// engine served fifteen translation routes here while `i18n/translations`
// served the same fifteen under `/ext/i18n/translations` — two live
// implementations over one set of tables, and the Studio called neither, since
// its own text is compiled in by paraglide.
//
// The comparison that settled it: not one route existed only in the engine.
// Deleting them loses nothing. And every other name in this list already
// answers 404 at `/api/<feature>` — `/api/database` and `/api/quality` do,
// with their extensions enabled — because extensions live under `/ext/<name>/`.
// Translations were the single exception, and only because this file kept
// serving them.
// ────────────────────────────────────────────────────────────────────────────

interface RoutesContext {
  db: Database;
  /**
   * The raw pool, for the few routes that must NOT run inside the request's
   * tenant transaction. Three kinds, and each has a reason rather than a
   * preference:
   *
   *  - it sets transaction-level properties of its own (`insights` and the SQL
   *    editor issue SET TRANSACTION READ ONLY and a statement_timeout, which
   *    must not be imposed on the whole request);
   *  - it runs SQL nobody wrote in this codebase, which may fail and, in
   *    Postgres, would abort the shared transaction along with the request;
   *  - it continues after the response (`backup`, flow execution), by which
   *    time the request transaction is committed and gone.
   *
   * Everything else takes `db` and shares the request's transaction, which is
   * what keeps one request to one pooled connection.
   */
  poolDb: Database;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  auth: any;
}

// Guard: one-time services — safe to call registerCoreRoutes() multiple times (hot-reload)
let _coreServicesInitialized = false;

export async function registerCoreRoutes(app: Hono, ctx: RoutesContext): Promise<void> {
  const { db, auth, poolDb } = ctx;

  if (!_coreServicesInitialized) {
    _coreServicesInitialized = true;
    // Bootstrap core collections through DDLManager before the DDL queue starts.
    await ensureCoreCollections(db);
    // Wire DB into rate limiter so configs from zv_rate_limit_configs override defaults
    initRateLimitDb(db);
    // Initialize DDL job queue (starts background polling — must run exactly once)
    await initDDLQueue(db);
  }

  // ── Distributed tracing — W3C traceparent on /api/* AND /ext/* so an
  // extension endpoint (SAML callback, mail download, …) appears under
  // the same trace as the rest of the request. Without /ext/* coverage
  // the spans for extension routes show up as orphans in Tempo / Jaeger.
  app.use('/api/*', tracingMiddleware());
  app.use('/ext/*', tracingMiddleware());

  // ── Demo-mode guard — no-op unless DEMO_MODE=true. Must run BEFORE
  // route handlers so we never reach a destructive endpoint even with a
  // god session. Mounted on /ext/* too, so an extension exposing a
  // destructive endpoint can't escape the demo-mode lockdown.
  app.use('/api/*', demoModeMiddleware());
  app.use('/ext/*', demoModeMiddleware());

  // ── Rate limiting ─────────────────────────────────────────────────────────
  //
  // Default-ON for every auth endpoint, with a short exemption list, rather than
  // naming the sensitive ones. Enumerating them left real holes: the limit was
  // mounted on `/api/auth/forgot-password` while better-auth's endpoint is
  // `/forget-password`, so password-reset email bombing was never limited at
  // all — and nothing covered `/reset-password`, `/magic-link/verify` or
  // `/two-factor/verify-totp`, where the secret is a six-digit code. With a
  // deny-by-default list, a new endpoint arrives limited instead of arriving
  // open.
  //
  // The exemptions are the reads the UI polls; rate-limiting those would break
  // the app rather than protect it.
  const AUTH_RATE_LIMIT_EXEMPT = new Set([
    '/api/auth/get-session',
    '/api/auth/list-sessions',
    '/api/auth/sign-out',
    '/api/auth/token',
    '/api/auth/jwks',
    '/api/auth/ok',
    '/api/auth/error',
  ]);
  app.use('/api/auth/*', async (c, next) => {
    if (AUTH_RATE_LIMIT_EXEMPT.has(c.req.path)) return next();
    return authRateLimit(c, next);
  });
  // Self-registration gate — public sign-up is allowed only when
  // `registration_enabled` is on (default OFF: Zveltio is app/intranet-first,
  // not open-registration). Guards the PUBLIC HTTP sign-up only; admin
  // invitations create users in-process (auth.api.signUpEmail, see routes/auth.ts)
  // and the CLI create-god path both bypass this middleware.
  app.on(['POST'], '/api/auth/sign-up/*', async (c, next) => {
    if (!(await isRegistrationEnabled(db))) {
      return c.json(
        {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          code: 'registration_disabled',
          detail: 'Self-registration is disabled on this instance.',
        },
        403,
      );
    }
    return next();
  });
  // Turning 2FA on ends every OTHER session.
  //
  // Better-Auth leaves them alone, which is the wrong default for what the
  // action means: a user enables 2FA because they think someone may have their
  // password, and every session that password already opened stays open until
  // it expires. Hardening the account did nothing to the sessions the attacker
  // is sitting in.
  //
  // Disable is covered too, and for the same reason read backwards — if 2FA is
  // being turned off, whoever did it should be the only one still signed in.
  //
  // The current session is spared, so the tab the user did this in keeps
  // working. Runs AFTER the handler and only on success: revoking sessions
  // because someone submitted a wrong TOTP code would be a denial of service
  // anyone could trigger.
  app.on(
    ['POST'],
    ['/api/auth/two-factor/enable', '/api/auth/two-factor/disable'],
    async (c, next) => {
      const before = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
      await next();
      if (c.res.status >= 400) return;
      const userId = before?.user?.id;
      if (!userId) return;
      const currentToken = (before as { session?: { token?: string } } | null)?.session?.token;
      // `poolDb`, not `db`. The request runs as `zveltio_rls`, which has no
      // grants on `session` since migration 044 — see the third reason in the
      // `poolDb` doc-comment above, which describes this exact failure.
      await revokeAllUserSessions(poolDb, userId, currentToken).catch((err: Error) => {
        // Still caught, and this one is a real judgement rather than a swallow:
        // the 2FA change has already committed, so failing the response now would
        // tell the user their factor was not enabled when it was. The log is the
        // signal, and with the handle fixed this should no longer fire.
        console.error(`[auth] could not revoke other sessions for ${userId}:`, err.message);
      });
    },
  );
  // SSO extension login paths get the same auth rate limit (10/min/IP) —
  // without this LDAP / SAML callback endpoints are wide-open to
  // credential-stuffing and brute-force. Mounted with `app.use` so it
  // covers `/login`, `/callback`, `/test`, etc. under each provider.
  app.use('/ext/auth/ldap/login', authRateLimit);
  app.use('/ext/auth/ldap/test', authRateLimit);
  app.use('/ext/auth/saml/callback', authRateLimit);
  // Stripe / payment webhooks: rate-limited so that forged signatures
  // can't exhaust CPU on the HMAC verify (each verify is cheap, but a
  // sustained flood is still wasteful). Real Stripe webhooks come from
  // a small set of IPs and well below 10/min — anyone hitting this
  // limit is almost certainly probing.
  app.use('/ext/billing/webhook/*', authRateLimit);

  // Pre-auth and anonymous extension surfaces. Everything under /ext/* already
  // has extRateLimit, but that is 600/min — a denial-of-service ceiling, not a
  // guessing one. At 600 attempts a minute a four-digit share password falls in
  // under twenty minutes, and nothing about the traffic looks unusual.
  //
  // Mounted here rather than inside each extension on purpose: this limiter is
  // Valkey-backed, so the count is shared across replicas and survives a
  // restart, which a counter living inside an extension process cannot be. It
  // also means no extension needs a version bump to become defended.
  //
  // Public form submission — anonymous by declaration (`publicRoutes:
  // ["/public/*"]`). The extension carried its own in-memory limiter, which
  // reset on every deploy and counted separately on every replica.
  app.use('/ext/forms/public/*', publicFormRateLimit);
  // Share links. `/share/:token` takes a password, so it is a login form that
  // does not look like one.
  app.use('/ext/storage/cloud/share/*', shareLinkRateLimit);
  // SCIM. The scim extension mounts this at the ROOT through
  // `registerPublicRoute`, so an IdP can reach the well-known path — which also
  // means it sits outside /ext/* and never had even the 600/min ceiling. It
  // authenticates a bearer token on every request, and until now an attacker
  // could try them without limit.
  app.use('/scim/v2/*', scimRateLimit);
  app.use('/api/ai/*', aiRateLimit);
  // Write operations (POST/PUT/PATCH/DELETE) on data are stricter (60/min) than reads (200/min)
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/api/data/*', writeRateLimit);
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/api/sync/*', writeRateLimit);

  // Destructive rate limit — DELETE on collections (schema) and data rows: 10/min
  app.on(['DELETE'], '/api/collections/*', destructiveRateLimit);
  app.on(['DELETE'], '/api/data/*', destructiveRateLimit);
  app.use('/api/*', apiRateLimit);

  // ── Tenant daily quota enforcement (runs after tenant middleware in index.ts) ──
  app.use('/api/*', tenantQuota(db, poolDb));

  // ── God-role audit trail — logs all actions by users with role='god' ──────
  app.use('/api/*', godAuditMiddleware(poolDb));

  // ── Request log — persists every /api/* call to zv_request_logs ──────────
  app.use('/api/*', requestLogMiddleware(poolDb));

  // ── Preview environments — X-Preview-Token switches PostgreSQL search_path ─
  app.use('/api/data/*', previewEnvMiddleware(db));

  // Changing a password ends every other session, and the client does not get
  // a say.
  //
  // better-auth takes `revokeOtherSessions` from the request body, so whether a
  // password change logs the attacker out was a decision each caller made for
  // itself. The Studio's profile page sent neither the flag nor a value, which
  // means false: a user who changes their password *because* they think someone
  // is in their account kept that someone signed in. The reset flow already
  // disagreed — `revokeSessionsOnPasswordReset: true` is set in the auth config
  // — so the same intent, expressed two ways, produced two outcomes.
  //
  // Forced here rather than fixed in the Studio because the SDKs and any
  // operator's own client hit this endpoint too, and one of them will always be
  // the one nobody updated. Found by driving a live instance: the old cookie
  // still returned 200 after the password had changed.
  app.post('/api/auth/change-password', async (c, next) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.raw.clone().json();
    } catch {
      return next(); // Not JSON — let better-auth reject it in its own words.
    }
    if (body.revokeOtherSessions === true) return next();

    const forced = new Request(c.req.raw, {
      body: JSON.stringify({ ...body, revokeOtherSessions: true }),
    });
    try {
      return await auth.handler(forced);
    } catch (err) {
      console.error('[Auth Handler] Unhandled error:', err);
      return c.json({ error: 'Auth handler failed' }, 500);
    }
  });

  // Better-Auth handler — handles all /api/auth/** routes
  app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
    try {
      return await auth.handler(c.req.raw);
    } catch (err) {
      console.error('[Auth Handler] Unhandled error:', err);
      return c.json({ error: 'Auth handler failed' }, 500);
    }
  });

  // Profile convenience routes
  app.route('/api/me', authRoutes(db, auth));

  // Public invitation accept flow (no session required)
  app.route('/api/invitations', invitationRoutes(db, auth));

  // Collections schema management (admin)
  app.route('/api/collections', collectionsRoutes(db, auth));

  // Collection relations (admin)
  app.route('/api/relations', relationsRoutes(db, auth));

  // Slow query detection for data endpoints
  app.use('/api/data/*', slowQueryMiddleware(poolDb));

  // Generic data CRUD (session + API key)
  app.route('/api/data', dataRoutes(db, auth));

  // Users management (admin)
  // `poolDb` as a third argument: deleting a user revokes their sessions, and
  // `session` is off-limits to the request's `zveltio_rls` role. Same shape as
  // `insightsRoutes(poolDb, auth)` and `backupRoutes(poolDb, auth)` below.
  app.route('/api/users', usersRoutes(db, auth, poolDb));

  // Permissions / Casbin (admin)
  app.route('/api/permissions', permissionsRoutes(db, auth));

  // Row-Level Security policies (admin)
  app.route('/api/admin/rls', rlsRoutes(db, auth));

  // RPC — whitelisted PostgreSQL function calls
  app.route('/api/rpc', rpcRoutes(db, auth));

  // File storage (authenticated)
  app.route('/api/storage', storageRoutes(db, auth));

  // Public file serving for the `local` storage driver (no-op for `s3`, whose
  // URLs point at the object store directly). Public + self-guarding: signed
  // URLs are HMAC-verified, unsigned access is public-by-unguessable-path.
  // Throttle public file serving per IP (a stripped/guessing scan of /files/* is
  // capped; a media player's Range bursts stay well under the limit).
  app.use('/files/*', filesRateLimit);
  app.route('/files', filesRoutes());

  // Webhooks (admin)
  app.route('/api/webhooks', webhooksRoutes(db, auth));

  // Settings (admin + public subset)
  app.route('/api/settings', settingsRoutes(db, auth));

  // Export — moved to extensions/data/export

  // Import CSV/JSON — moved to extensions/data/import

  // Health + version + migration status + update check (public)
  app.route('/api/health', healthRoutes(db, auth));

  // OpenAPI spec — always public, useful for SDK generation and docs
  app.route('/api/openapi.json', openApiRoutes());

  // Admin utilities: API keys, notifications, audit, types, onboarding
  app.route('/api/admin', adminRoutes(db, auth));

  // API keys direct endpoint (tests + SDK use /api/api-keys)
  app.route('/api/api-keys', apiKeysRoutes(db, auth));

  // Revisions + record comments (authenticated)
  app.route('/api/revisions', revisionsRoutes(db, auth));

  // i18n translations (core — always available)

  // In-app notifications + web push (authenticated)
  app.route('/api/notifications', notificationsRoutes(db, auth));

  // Real-time SSE stream (authenticated)
  app.route('/api/realtime', realtimeRoutes(db, auth));

  // Zones / Pages / Views — 3-layer portal architecture

  // Approval Workflows (core)
  app.route('/api/approvals', approvalsRoutes(db, auth));

  // Data Export: JSON / CSV / NDJSON
  app.route('/api/export', exportRoutes(db, auth));

  // Data Import: CSV / JSON / NDJSON (core — universal feature)
  app.route('/api/import', importRoutes(db, auth));

  // Extension marketplace — moved to extensionLoader.registerMarketplace() in bootstrap

  // Schema branches — moved to extensions/developer/schema-branches

  // API documentation portal — moved to extensions/developer/api-docs

  // Database management — moved to extensions/developer/database

  // Media library
  app.route('/api/media', mediaRoutes(db, auth));

  // Database backups — moved to extensions/operations/backup

  // GraphQL auto-generated API — moved to extensions/developer/graphql

  // Approval Workflows — moved to extensions/workflow/approvals

  // Content Draft/Publish Workflow — moved to extensions/content/drafts

  // GDPR Compliance — moved to extensions/compliance/gdpr

  // Saved Queries — promoted to core (used to live in extensions/developer/saved-queries)
  app.route('/api/saved-queries', savedQueriesRoutes(db, auth));

  // Data Validation Rules — moved to extensions/developer/validation

  // Data Quality Dashboard — moved to extensions/analytics/quality

  // Analytics Insights — promoted to core (used to live in extensions/analytics/insights)
  app.route('/api/insights', insightsRoutes(poolDb, auth));

  // What the business needs from you today, as opposed to what the platform is
  // doing. Derived from the core `transactions` collection, so it answers on an
  // install with no extensions at all. See routes/briefing.ts.
  app.route('/api/briefing', briefingRoutes(db, auth));

  // Database backups + PITR — promoted to core (was extensions/operations/backup)
  app.route('/api/backup', backupRoutes(poolDb, auth));

  // Schema Branches — promoted to core (was extensions/developer/schema-branches)
  app.route('/api/schema', schemaBranchesRoutes(db, auth));

  // Ad-hoc SQL editor — admin-only, audited
  app.route('/api/admin/sql', sqlEditorRoutes(poolDb, auth));

  // Pre-built business templates (CRM / Invoicing / Project / Help Desk / Inventory)
  app.route('/api/templates', templatesRoutes(db, auth));

  // Per-user ERD positions for the schema-diagram view
  app.route('/api/erd/layout', erdLayoutRoutes(db, auth));

  // Documents Management — moved to extensions/content/documents

  // Automation flows (core)
  app.route('/api/flows', flowsRoutes(poolDb, auth));

  // Multi-tenancy management (core)
  app.route('/api/tenants', tenantsRoutes(db, auth));

  // AI — moved to extensions/ai. Mounts /api/ai*, /api/zveltio-ai, /api/ai-analytics.

  // SDK Local-First Sync (push/pull batch operations)
  app.route('/api/sync', syncRoutes(db, auth));

  // Electric SQL bridge — token mint + config for clients using the
  // `electric` offline-sync provider. 503s when ELECTRIC_URL +
  // ELECTRIC_AUTH_TOKEN are unset so the SDK can fall back to CRDT.
  app.route('/api/electric', electricRoutes(db, auth));

  // BYOD Introspection — moved to extensions/developer/byod

  // Edge Functions — CRUD + sandboxed Bun Worker execution
  app.route('/api/edge-functions', edgeFunctionsRoutes(db, auth));
  app.route('/api/fn', edgeFunctionInvokeRoutes(db, auth));

  // P2: XML-escape helper to prevent injection via SITE_URL or page slugs
  function xmlEscape(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Sitemap (public)
  app.get('/api/sitemap.xml', async (c) => {
    const siteUrl = xmlEscape(process.env.SITE_URL || 'https://example.com');
    try {
      const pages = await sql<{ slug: string; updated_at: Date }>`
        SELECT slug, updated_at FROM zv_pages WHERE is_active = true ORDER BY slug
      `.execute(db);

      const urls = pages.rows
        .map(
          (p) => `  <url>
    <loc>${siteUrl}/${xmlEscape(p.slug)}</loc>
    <lastmod>${new Date(p.updated_at).toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
  </url>`,
        )
        .join('\n');

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
${urls}
</urlset>`;

      return c.text(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
    } catch (err) {
      // A 500, not an empty sitemap with 200.
      //
      // Both this handler and a `.catch(() => ({ rows: [] }))` on the query above
      // answered a failed read with `<urlset></urlset>` and a 200. To a crawler that
      // is not an error — it is the site stating, successfully, that it has no
      // pages, and acting on it is what a crawler is for. Pages drop out of the
      // index and come back only when someone notices.
      //
      // 5xx is the documented way to say "ask again later": the previous sitemap is
      // kept and the fetch is retried.
      console.error(
        '[sitemap] could not list pages; serving 500 rather than an empty sitemap:',
        err,
      );
      return c.text('sitemap temporarily unavailable', 500, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }
  });

  // WebSocket info (actual upgrade in Bun.serve)
  app.route('', wsRoutes(db, auth));
}
