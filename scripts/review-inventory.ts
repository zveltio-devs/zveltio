#!/usr/bin/env bun
/**
 * review-inventory.ts — the file-by-file code review campaign ledger.
 *
 * Reads:
 *   docs/private/code-review-status.json   (append-only session log, edited by agents)
 * Writes:
 *   docs/private/CODE-REVIEW-STATE.md      (the checklist, generated)
 *
 * Why a generator and not a hand-kept table: the sibling repository's
 * REVIEW-STATUS.md says of itself "generated automatically is an intention, not
 * a fact — there is no generator, and the numeric columns have drifted away
 * from the files". A hand-kept checklist over 1,500 files drifts the same way.
 *
 * Exit code 1 when a tracked source file matches no section. That is the point:
 * a file added to the tree cannot silently escape the campaign — it lands in
 * UNASSIGNED and someone has to place it.
 *
 * Run: `bun run review:inventory`
 */

type Section = {
  id: string;
  track: string;
  title: string;
  /** The risk this section carries — why it is grouped this way, one line. */
  focus: string;
  /** Exact paths, or prefixes ending in `/`. First matching section wins. */
  match: string[];
};

type Finding = {
  severity: 'critical' | 'high' | 'medium' | 'low';
  where: string;
  what: string;
  status: 'fixed' | 'logged' | 'deferred';
  ref?: string;
};

type SessionEntry = {
  section: string;
  date: string;
  agent: string;
  branch?: string;
  /** Source files read line by line in this session. */
  files: string[];
  /** Test files opened to check whether they would catch a real break. */
  tests?: string[];
  /** Commands actually run, with their result. Reading is not verifying. */
  ran?: string[];
  findings?: Finding[];
  /** What was deliberately left undone, and why. */
  notDone?: string;
  /** `logged` = read in full, findings recorded, nothing repaired in-session. */
  verdict: 'clean' | 'repaired' | 'logged' | 'blocked' | 'partial';
};

type Ledger = { updated: string; sessions: SessionEntry[] };

const STATUS_JSON = 'docs/private/code-review-status.json';
const OUTPUT_MD = 'docs/private/CODE-REVIEW-STATE.md';
const SESSIONS_DIR = 'docs/private/review-sessions';

// ─────────────────────────────────────────────────────────────────────────────
// Section map. Ordered: first match wins, so narrow entries precede prefixes.
// ─────────────────────────────────────────────────────────────────────────────

const E = 'packages/engine/src/';
const S = 'packages/studio/src/';

const SECTIONS: Section[] = [
  // ── Track X — accounted for, not reviewed in this repository ──────────────
  {
    id: 'X01',
    track: 'X — out of scope here',
    title: 'Synced from zveltio-extensions',
    focus:
      'Destination copies of extension UI. Editing them here is erased by the next sync — ' +
      'they are reviewed in the sibling repository, against its own checklist.',
    match: [
      `${S}lib/ext/`,
      'packages/client/src/lib/ext/',
      `${S}routes/(admin)/ai/`,
      `${S}routes/(admin)/developer/`,
      `${S}routes/(admin)/geospatial/`,
      `${S}routes/(admin)/mail/`,
      `${S}routes/(admin)/pages/`,
      `${S}routes/(admin)/projects/`,
    ],
  },
  {
    id: 'X02',
    track: 'X — out of scope here',
    title: 'Generated artifacts',
    focus:
      'Never hand-edited. Reviewed indirectly: the section owning the generator answers for ' +
      'what comes out of it, and a freshness gate owns the drift.',
    match: [
      `${E}db/schema.generated.ts`,
      `${E}db/migrations/embedded.ts`,
      `${E}lib/worker-extension-runtime-source.generated.ts`,
      `${E}studio-embed/index.ts`,
      `${S}lib/ext/.contributions.generated.ts`,
    ],
  },
  {
    id: 'X03',
    track: 'X — out of scope here',
    title: 'Archived one-shot scripts',
    focus:
      'One-shot i18n and repair scripts that already ran. Out of scope as code — but E05 ' +
      'should decide whether they stay tracked at all.',
    match: [`packages/studio/scripts/archive/`],
  },

  // ── Track A — engine core: a defect here is a leak or a corruption ────────
  {
    id: 'A01',
    track: 'A — engine core',
    title: 'Boot, app assembly, middleware order',
    focus: 'Registration order decides which guard runs. A gap here disables every guard after it.',
    match: [
      `${E}index.ts`,
      `${E}routes/index.ts`,
      `${E}lib/startup-guards.ts`,
      `${E}lib/service-registry.ts`,
      `${E}version.ts`,
      `${E}api-types.ts`,
      `${E}types/`,
    ],
  },
  {
    id: 'A02',
    track: 'A — engine core',
    title: 'Middleware chain',
    focus: 'Tenant resolution, rate limits, auth gates, and the handover to the request-scoped DB.',
    match: [`${E}middleware/`, `${E}lib/route-db.ts`, `${E}lib/savepoint.ts`],
  },
  {
    id: 'A03',
    track: 'A — engine core',
    title: 'Error surface, health, API description',
    focus: 'What leaks in an error body, and whether health lies about a degraded instance.',
    match: [
      `${E}lib/problem.ts`,
      `${E}routes/health.ts`,
      `${E}lib/health-registry.ts`,
      `${E}lib/version-checker.ts`,
      `${E}routes/gone.ts`,
      `${E}lib/utils.ts`,
      `${E}lib/introspection.ts`,
      `${E}lib/doc-generator.ts`,
      `${E}routes/openapi.ts`,
    ],
  },
  {
    id: 'A04',
    track: 'A — engine core',
    title: 'Tenancy core',
    focus:
      'The GUC, the request-scoped transaction, the role switch. Every isolation claim rests here.',
    match: [
      `${E}lib/tenancy/tenant-manager.ts`,
      `${E}lib/tenancy/tenant-context.ts`,
      `${E}lib/tenancy/tenant-scope.ts`,
      `${E}lib/tenancy/fail-closed-tenant.ts`,
      `${E}lib/tenancy/index.ts`,
    ],
  },
  {
    id: 'A05',
    track: 'A — engine core',
    title: 'RLS policies and row rules',
    focus:
      'Predicate shape decides both correctness and the query plan; one interpreter for the rules.',
    match: [
      `${E}lib/tenancy/rls.ts`,
      `${E}lib/tenancy/row-rule-policy.ts`,
      `${E}lib/tenancy/rule-operators.ts`,
      `${E}lib/tenancy/entity-access.ts`,
      `${E}lib/tenancy/denial.ts`,
      `${E}lib/tenancy/signed-cache.ts`,
      `${E}routes/rls.ts`,
    ],
  },
  {
    id: 'A06',
    track: 'A — engine core',
    title: 'Permissions, roles, column access',
    focus: 'Deny by default, cache invalidation across replicas, hidden versus read-only columns.',
    match: [
      `${E}lib/tenancy/permissions.ts`,
      `${E}lib/tenancy/resource-grants.ts`,
      `${E}lib/tenancy/column-permissions.ts`,
      `${E}routes/permissions.ts`,
      `${E}routes/admin/permission-routes.ts`,
    ],
  },
  {
    id: 'A07',
    track: 'A — engine core',
    title: 'Authentication and identity',
    focus: 'Sessions, API keys, SSO, key material. Revocation must reach every replica.',
    match: [
      `${E}lib/auth.ts`,
      `${E}routes/auth.ts`,
      `${E}routes/users.ts`,
      `${E}lib/security/sso-session.ts`,
      `${E}lib/security/api-key-hash.ts`,
      `${E}lib/security/keyring.ts`,
      `${E}lib/security/index.ts`,
    ],
  },
  {
    id: 'A08',
    track: 'A — engine core',
    title: 'Database layer, pool, dialect, migration runner',
    focus: 'Connection accounting, transaction boundaries, prepared-plan invalidation.',
    match: [
      `${E}db/index.ts`,
      `${E}db/bun-sql-dialect.ts`,
      `${E}db/dynamic.ts`,
      `${E}db/dynamic-types.ts`,
      `${E}db/pool-autosize.ts`,
      `${E}db/connection-trace.ts`,
      `${E}db/auto-migrate.ts`,
      `${E}db/migrate.ts`,
      `${E}db/migrations/index.ts`,
      `${E}lib/jsonb.ts`, // on master, not on every branch
    ],
  },
  {
    id: 'A09',
    track: 'A — engine core',
    title: 'Base schema (001_initial.sql)',
    focus:
      'Every table in one file: FORCE RLS, tenant column, unique keys carrying tenant_id, ' +
      'indexes matching the access patterns. Read it against a live database, not alone.',
    match: [`${E}db/migrations/sql/001_initial.sql`],
  },
  {
    id: 'A10',
    track: 'A — engine core',
    title: 'Schema types and incremental migrations',
    focus:
      'Kysely types against the real columns, and the upgrade path from an instance ' +
      'installed before the squash.',
    match: [`${E}db/schema.ts`, `${E}db/migrations/sql/`],
  },
  {
    id: 'A11',
    track: 'A — engine core',
    title: 'Data write path',
    focus:
      'Reserved fields, tenant_id arriving in a body, hooks, and what a `return` inside a ' +
      'transaction commits.',
    match: [
      `${E}lib/data/write-pipeline.ts`,
      `${E}lib/data/handlers/single.ts`,
      `${E}lib/data/handlers/bulk.ts`,
      `${E}lib/data/auth.ts`,
      `${E}lib/data/types.ts`,
      `${E}lib/data/index.ts`,
      `${E}lib/data/import-logs-contract.ts`,
      `${E}routes/data.ts`,
    ],
  },
  {
    id: 'A12',
    track: 'A — engine core',
    title: 'Data read path',
    focus: 'Filter parsing, plan shape, cache keys that must carry the tenant, N+1 in the loader.',
    match: [
      `${E}lib/data/handlers/list.ts`,
      `${E}lib/data/query-parse.ts`,
      `${E}lib/data/query-cache.ts`,
      `${E}lib/data/query-alter.ts`,
      `${E}lib/data/query-utils.ts`,
      `${E}lib/data/shape.ts`,
      `${E}lib/data/time-travel-count.ts`,
      `${E}lib/graphql-dataloader.ts`,
      `${E}lib/virtual-collection-adapter.ts`,
    ],
  },
  {
    id: 'A13',
    track: 'A — engine core',
    title: 'DDL manager, queue, ghost DDL',
    focus: 'Identifier quoting, two creators for one table, orphans left behind by a failed run.',
    match: [
      `${E}lib/data/ddl-manager.ts`,
      `${E}lib/data/ddl-queue.ts`,
      `${E}lib/data/ghost-ddl.ts`,
    ],
  },
  {
    id: 'A14',
    track: 'A — engine core',
    title: 'Field types, validation, field encryption',
    focus: 'Type conversion over live data, numeric handling, the encryption key path.',
    match: [
      `${E}field-types/`,
      `${E}lib/data/field-type-registry.ts`,
      `${E}lib/data/field-type-conversions.ts`,
      `${E}lib/data/field-crypto.ts`,
      `${E}lib/validation-engine.ts`,
      `${E}lib/numeric.ts`,
    ],
  },
  {
    id: 'A15',
    track: 'A — engine core',
    title: 'Collection, relation and revision routes',
    focus: 'The routes that change user schema at runtime, and revision revert.',
    match: [
      `${E}routes/collections.ts`,
      `${E}routes/relations.ts`,
      `${E}routes/revisions.ts`,
      `${E}routes/erd-layout.ts`,
      `${E}routes/schema-branches.ts`,
    ],
  },
  {
    id: 'A16',
    track: 'A — engine core',
    title: 'Tenant and admin routes',
    focus:
      'The privileged surface: a guard on every route, an audit entry on every privileged write.',
    match: [`${E}routes/tenants.ts`, `${E}routes/admin.ts`, `${E}routes/admin/`],
  },
  {
    id: 'A17',
    track: 'A — engine core',
    title: 'Settings, audit trail, templates, RPC, data quality',
    focus: 'The audit writer itself, and the routes that read or reshape whole instances.',
    match: [
      `${E}lib/audit.ts`,
      `${E}routes/settings.ts`,
      `${E}lib/system-collections.ts`,
      `${E}lib/notifications.ts`,
      `${E}routes/templates.ts`,
      `${E}routes/rpc.ts`,
      `${E}lib/data-quality.ts`,
    ],
  },

  // ── Track B — engine subsystems ──────────────────────────────────────────
  {
    id: 'B01',
    track: 'B — engine subsystems',
    title: 'Extension loading and lifecycle',
    focus: 'Load order against engine boot; enable/disable actually reloading the bundle.',
    match: [
      `${E}lib/extensions/extension-loader.ts`,
      `${E}lib/extensions/load.ts`,
      `${E}lib/extensions/load-phases.ts`,
      `${E}lib/extensions/activation.ts`,
      `${E}lib/extensions/lifecycle.ts`,
      `${E}lib/extensions/discovery.ts`,
      `${E}lib/extensions/extension-paths.ts`,
    ],
  },
  {
    id: 'B02',
    track: 'B — engine subsystems',
    title: 'Extension context and host internals',
    focus:
      'The handle handed to an extension: what it can reach, versus what the type says it can.',
    match: [
      `${E}lib/extensions/extension-context.ts`,
      `${E}lib/extensions/internals.ts`,
      `${E}lib/extensions/register.ts`,
      `${E}lib/extensions/capabilities.ts`,
      `${E}lib/extensions/config.ts`,
      `${E}lib/extensions/index.ts`,
    ],
  },
  {
    id: 'B03',
    track: 'B — engine subsystems',
    title: 'Worker and WASM isolation',
    focus:
      'The SQL allowlist, the reserved connection, the role with no grants. Allowlist, never denylist.',
    match: [
      `${E}lib/worker-extension-host.ts`,
      `${E}lib/worker-extension-runtime.ts`,
      `${E}lib/worker-extension-protocol.ts`,
      `${E}lib/extensions/worker-sql-policy.ts`,
      `${E}lib/extensions/extension-sandbox.ts`,
      `${E}lib/wasm-extension-host.ts`,
    ],
  },
  {
    id: 'B04',
    track: 'B — engine subsystems',
    title: 'Marketplace, download, signature, trust',
    focus: 'Signature verification, revocation, consent — the chain that decides what code runs.',
    match: [
      `${E}lib/extensions/extension-marketplace-routes.ts`,
      `${E}lib/extensions/extension-download.ts`,
      `${E}lib/security/signature-verify.ts`,
      `${E}lib/security/registry-keys.ts`,
      `${E}lib/extensions/revocations.ts`,
      `${E}lib/extensions/consent.ts`,
      `${E}lib/extensions/extension-license.ts`,
    ],
  },
  {
    id: 'B05',
    track: 'B — engine subsystems',
    title: 'Manifest, catalog, dependencies, extension migrations',
    focus:
      'The manifest v2 contract, and the extension migration runner — it has no DDL lint gate.',
    match: [
      `${E}lib/extensions/manifest-schema.ts`,
      `${E}lib/extensions/extension-catalog.ts`,
      `${E}lib/extensions/extension-registry.ts`,
      `${E}lib/extensions/extension-utils.ts`,
      `${E}lib/extensions/extension-errors.ts`,
      `${E}lib/extensions/migration-runner.ts`,
      `${E}lib/extensions/extension-deps.ts`,
      `${E}lib/extensions/npm-install.ts`,
      `${E}lib/peer-deps-allowlist.ts`,
    ],
  },
  {
    id: 'B06',
    track: 'B — engine subsystems',
    title: 'Realtime, WebSocket, event bus',
    focus: 'Channel authorisation, presence across replicas, origin checks.',
    match: [
      `${E}routes/realtime.ts`,
      `${E}routes/ws.ts`,
      `${E}lib/runtime/realtime-bus.ts`,
      `${E}lib/runtime/event-bus.ts`,
      `${E}lib/security/ws-origin.ts`,
    ],
  },
  {
    id: 'B07',
    track: 'B — engine subsystems',
    title: 'Flows and cron',
    focus: 'Fencing between replicas, the DLQ, and what a step does with a failure.',
    match: [`${E}lib/flows/`, `${E}lib/runtime/cron-runner.ts`, `${E}routes/flows.ts`],
  },
  {
    id: 'B08',
    track: 'B — engine subsystems',
    title: 'Webhooks and notifications',
    focus: 'HMAC signing, retry and DLQ, SSRF on the outbound URL, push token ownership.',
    match: [
      `${E}lib/webhooks.ts`,
      `${E}lib/webhook-worker.ts`,
      `${E}routes/webhooks.ts`,
      `${E}lib/push-notifications.ts`,
      `${E}routes/notifications.ts`,
    ],
  },
  {
    id: 'B09',
    track: 'B — engine subsystems',
    title: 'Storage, files, media',
    focus: 'Path traversal, per-tenant prefixes, quota, and who may read a file by id.',
    match: [
      `${E}lib/storage/`,
      `${E}lib/storage-quota.ts`,
      `${E}lib/media-visibility.ts`,
      `${E}routes/storage.ts`,
      `${E}routes/files.ts`,
      `${E}lib/cloud/`,
      `${E}lib/pdf-queue.ts`,
      `${E}workers/`,
    ],
  },
  {
    id: 'B10',
    track: 'B — engine subsystems',
    title: 'Backup, PITR, restore',
    focus:
      'Every exit code on the dump path. A truncated dump reported as completed is the worst ' +
      'defect this system can carry.',
    match: [`${E}lib/backup/`, `${E}routes/backup.ts`],
  },
  {
    id: 'B11',
    track: 'B — engine subsystems',
    title: 'Edge functions and script execution',
    focus: 'Subprocess env, the lockdown list, where the SSRF guard sits, CSV formula injection.',
    match: [
      `${E}lib/edge-functions/`,
      `${E}lib/edge-function-runner.ts`,
      `${E}routes/edge-functions.ts`,
      `${E}lib/script-runner.ts`,
      `${E}lib/security/url-validator.ts`,
      `${E}lib/security/csv.ts`,
    ],
  },
  {
    id: 'B12',
    track: 'B — engine subsystems',
    title: 'Insights, saved queries, SQL editor',
    focus: 'User-authored SQL: which role runs it, on which connection, with which timeout.',
    match: [`${E}routes/insights.ts`, `${E}routes/saved-queries.ts`, `${E}routes/sql-editor.ts`],
  },
  {
    id: 'B13',
    track: 'B — engine subsystems',
    title: 'Sync, Electric, runtime infrastructure',
    focus: 'Offline push/pull conflict handling, cache invalidation, the memory and GC loops.',
    match: [`${E}routes/sync.ts`, `${E}routes/electric.ts`, `${E}lib/runtime/`],
  },

  // ── Track C — Studio and client ──────────────────────────────────────────
  {
    id: 'C01',
    track: 'C — Studio & client',
    title: 'Studio shell, routing, API client, build config',
    focus: 'Auth guard on every admin route, the API prefix, redirect handling.',
    match: [
      `${S}routes/+error.svelte`,
      `${S}routes/+layout.svelte`,
      `${S}routes/+layout.ts`,
      `${S}routes/login/`,
      `${S}routes/(admin)/+error.svelte`,
      `${S}routes/(admin)/+layout.svelte`,
      `${S}routes/(admin)/+layout.ts`,
      `${S}routes/(admin)/+page.svelte`,
      `${S}routes/(admin)/[...extPath]/`,
      `${S}routes/(admin)/extensions/`,
      `${S}lib/api.ts`,
      `${S}lib/config.ts`,
      `${S}lib/auth.svelte.ts`,
      `${S}lib/nav-model.ts`,
      `${S}lib/nav-i18n.ts`,
      `${S}lib/i18n.svelte.ts`,
      `${S}lib/denial.ts`,
      `${S}hooks.client.ts`,
      `${S}service-worker.ts`,
      'packages/studio/svelte.config.js',
      'packages/studio/vite.config.ts',
      'packages/studio/vitest.config.ts',
    ],
  },
  {
    id: 'C02',
    track: 'C — Studio & client',
    title: 'SDUI renderer — SchemaPage',
    focus: 'The one file that renders every extension page. A defect here is 56 extensions wide.',
    match: [`${S}lib/sdui/SchemaPage.svelte`, `${S}lib/sdui/types.ts`, `${S}lib/sdui/validate.ts`],
  },
  {
    id: 'C03',
    track: 'C — Studio & client',
    title: 'SDUI renderer — layouts',
    focus: 'Builder, detail and settings layouts; schema fields that silently do nothing.',
    match: [`${S}lib/sdui/`],
  },
  {
    id: 'C04',
    track: 'C — Studio & client',
    title: 'Components — collections and fields',
    focus: 'The data table and the record drawer: what they send, and what they hide.',
    match: [`${S}lib/components/collections/`, `${S}lib/components/fields/`],
  },
  {
    id: 'C05',
    track: 'C — Studio & client',
    title: 'Components — common',
    focus: 'Shared primitives. Dead classes, unsanitised HTML, permission guards that only hide.',
    match: [`${S}lib/components/common/`],
  },
  {
    id: 'C06',
    track: 'C — Studio & client',
    title: 'Components — layout, navigation, extensions, marketplace',
    focus: 'The navigation model against real permissions; the extension contribution slots.',
    match: [`${S}lib/components/`],
  },
  {
    id: 'C07',
    track: 'C — Studio & client',
    title: 'Admin pages — collections and data',
    focus: 'The most used screen in the product.',
    match: [`${S}routes/(admin)/collections/`],
  },
  {
    id: 'C08',
    track: 'C — Studio & client',
    title: 'Admin pages — tenants, permissions, users, RLS, API keys',
    focus:
      'Screens that grant access. A misleading form here is a permission nobody meant to give.',
    match: [
      `${S}routes/(admin)/tenants/`,
      `${S}routes/(admin)/permissions/`,
      `${S}routes/(admin)/users/`,
      `${S}routes/(admin)/rls/`,
      `${S}routes/(admin)/column-permissions/`,
      `${S}routes/(admin)/api-keys/`,
    ],
  },
  {
    id: 'C09',
    track: 'C — Studio & client',
    title: 'Admin pages — flows, marketplace, schema branches, templates, onboarding',
    focus: 'Screens that install or execute something.',
    match: [
      `${S}routes/(admin)/flows/`,
      `${S}routes/(admin)/marketplace/`,
      `${S}routes/(admin)/schema-branches/`,
      `${S}routes/(admin)/templates/`,
      `${S}routes/(admin)/onboarding/`,
    ],
  },
  {
    id: 'C10',
    track: 'C — Studio & client',
    title: 'Admin pages — insights, saved queries, settings, storage, backup',
    focus: 'Screens that read across the whole instance or move data out of it.',
    match: [
      `${S}routes/(admin)/insights/`,
      `${S}routes/(admin)/saved-queries/`,
      `${S}routes/(admin)/settings/`,
      `${S}routes/(admin)/storage/`,
      `${S}routes/(admin)/backup/`,
    ],
  },
  {
    id: 'C11',
    track: 'C — Studio & client',
    title: 'Admin pages — the rest',
    focus: 'Webhooks, RPC, virtual collections, audit, notifications, request logs, SQL, account.',
    match: [`${S}routes/(admin)/`],
  },
  {
    id: 'C12',
    track: 'C — Studio & client',
    title: 'Studio stores, utilities, sanitiser',
    focus: 'Runes state shared across pages, the HTML sanitiser, safe redirect.',
    match: [
      `${S}lib/stores/`,
      `${S}lib/utils/`,
      `${S}lib/sanitize.ts`,
      `${S}lib/extension-api.svelte.ts`,
      `${S}lib/extensions.svelte.ts`,
      `${S}lib/load-extension-contributions.ts`,
    ],
  },
  {
    id: 'C13',
    track: 'C — Studio & client',
    title: 'Public web host and intranet routes',
    focus: 'The anonymous surface inside Studio. Every prior public leak was found on this shape.',
    match: [`${S}routes/(client)/`, `${S}routes/(intranet)/`],
  },
  {
    id: 'C14',
    track: 'C — Studio & client',
    title: 'Client package',
    focus: 'The end-user app: block renderer, binding, sanitiser, guards.',
    match: ['packages/client/'],
  },

  // ── Track D — SDK, CLI, bindings ─────────────────────────────────────────
  {
    id: 'D01',
    track: 'D — SDK, CLI, bindings',
    title: 'SDK core and codegen',
    focus: 'The API-stable surface. A break here breaks every extension at once.',
    match: [
      'packages/sdk/src/client.ts',
      'packages/sdk/src/core.ts',
      'packages/sdk/src/errors.ts',
      'packages/sdk/src/index.ts',
      'packages/sdk/src/types.ts',
      'packages/sdk/src/schema-codegen.ts',
      'packages/sdk/src/generate-types.ts',
      'packages/sdk/src/schema-watcher.ts',
    ],
  },
  {
    id: 'D02',
    track: 'D — SDK, CLI, bindings',
    title: 'SDK extension surface',
    focus: 'What an extension author is promised — the contract the engine must keep honouring.',
    match: ['packages/sdk/src/extension/'],
  },
  {
    id: 'D03',
    track: 'D — SDK, CLI, bindings',
    title: 'SDK validation, publishing, build, DDL, RPC',
    focus: 'What the validator actually checks, and what it lets through.',
    match: [
      'packages/sdk/src/validate/',
      'packages/sdk/src/publish/',
      'packages/sdk/src/build/',
      'packages/sdk/src/studio/',
      'packages/sdk/src/ddl/',
      'packages/sdk/src/rpc/',
    ],
  },
  {
    id: 'D04',
    track: 'D — SDK, CLI, bindings',
    title: 'SDK offline, sync, test harness',
    focus: 'Conflict resolution, the local store, and the harness other suites trust.',
    match: ['packages/sdk/'],
  },
  {
    id: 'D05',
    track: 'D — SDK, CLI, bindings',
    title: 'CLI — install, migrate, deploy, keys',
    focus: 'The CLI once reported a successful migration that applied nothing. Run each command.',
    match: [
      'packages/cli/src/index.ts',
      'packages/cli/src/commands/init.ts',
      'packages/cli/src/commands/install.ts',
      'packages/cli/src/commands/deploy.ts',
      'packages/cli/src/commands/update.ts',
      'packages/cli/src/commands/migrate.ts',
      'packages/cli/src/commands/rollback.ts',
      'packages/cli/src/commands/start.ts',
      'packages/cli/src/commands/dev.ts',
      'packages/cli/src/commands/status.ts',
      'packages/cli/src/commands/keys.ts',
      'packages/cli/src/commands/create-god.ts',
      'packages/cli/src/commands/version-cmd.ts',
      'packages/cli/src/commands/generate-types.ts',
    ],
  },
  {
    id: 'D06',
    track: 'D — SDK, CLI, bindings',
    title: 'CLI — extension commands',
    focus:
      'pack, publish, validate, dev. A pack that ships stale source is invisible until production.',
    match: ['packages/cli/'],
  },
  {
    id: 'D07',
    track: 'D — SDK, CLI, bindings',
    title: 'React and Vue bindings',
    focus: 'Thin wrappers — check they have not drifted from the SDK contract.',
    match: ['packages/sdk-react/', 'packages/sdk-vue/'],
  },

  // ── Track E — gates, tooling, harness ────────────────────────────────────
  {
    id: 'E01',
    track: 'E — gates & harness',
    title: 'Gates — tenancy, SQL and data safety',
    focus: 'Plant a violation in each. A gate that does not fail on it is not a gate.',
    match: [
      'scripts/check-tenant-boundary.ts',
      'scripts/check-tenant-table-on-pool.ts',
      'scripts/check-pooldb-txn-skip.ts',
      'scripts/check-atomic-writes.ts',
      'scripts/check-raw-sql-identifiers.ts',
      'scripts/check-sql-template-backticks.ts',
      'scripts/check-numeric-string-arithmetic.ts',
      'scripts/check-insert-schema-match.ts',
      'scripts/check-duplicate-table-creators.ts',
      'scripts/check-duplicate-rules.ts',
      'scripts/check-rule-interpreters.ts',
      'scripts/check-migration-safety.ts',
      // On master, not on every branch. Listed ahead of arrival so a catch-up
      // merge files it here rather than under "operational scripts".
      'scripts/check-jsonb-binding.ts',
    ],
  },
  {
    id: 'E02',
    track: 'E — gates & harness',
    title: 'Gates — authorisation, audit, structure',
    focus:
      'Which of these read the sibling repository, and which report clean when they cannot find it.',
    match: [
      'scripts/admin-gate-check.ts',
      'scripts/check-ambient-authority.ts',
      'scripts/audit-inventory.ts',
      'scripts/audit-regression-check.ts',
      'scripts/audit-gates.ts',
      'scripts/route-collision-check.ts',
      'scripts/import-boundaries.ts',
      'scripts/check-fabricated-success.ts',
      'scripts/check-gate-coverage.ts',
      'scripts/check-test-leftovers.ts',
      'scripts/check-env-documented.ts', // on master, not on every branch
    ],
  },
  {
    id: 'E03',
    track: 'E — gates & harness',
    title: 'Gates — artifact freshness and i18n',
    focus: 'Freshness gates over generated trees. Three trees for the extension snapshot, not two.',
    match: [
      'scripts/check-embedded-deps-fresh.ts',
      'scripts/check-embedded-migrations-fresh.ts',
      'scripts/check-ext-snapshot-fresh.ts',
      'scripts/check-studio-embed-freshness.ts',
      'scripts/check-studio-api-prefix.ts',
      'scripts/check-worker-source-fresh.ts',
      'scripts/check-i18n-core.ts',
      'scripts/check-extension-i18n-ownership.ts',
      'scripts/check-extension-page-ownership.ts',
      'scripts/check-extension-sdui-schemas.ts',
      'scripts/check-sdui-contract.ts',
      'scripts/sync-shared-message-keys.ts',
      'scripts/schema-codegen.ts',
      'scripts/schema-drift-check.ts',
      'scripts/schema-snapshot.ts',
      'scripts/check-extension-i18n-namespaces.ts', // on master, not on every branch
    ],
  },
  {
    id: 'E04',
    track: 'E — gates & harness',
    title: 'Gates — coverage, ratchets, release',
    focus:
      'Baselines that go stale against master, and a coverage gate that reads a number instead ' +
      'of measuring.',
    match: [
      'scripts/coverage-gate.ts',
      'scripts/merge-coverage.ts',
      'scripts/any-ratchet.ts',
      'scripts/lint-warning-ratchet.ts',
      'scripts/release-gate.ts',
      'scripts/suppress-existing-any.ts',
      'scripts/review-inventory.ts',
      'scripts/lib/',
    ],
  },
  {
    id: 'E05',
    track: 'E — gates & harness',
    title: 'Build, packaging and Studio tooling scripts',
    focus: 'The generators behind X02, and the sync that overwrites Studio from the sibling repo.',
    match: ['packages/engine/scripts/', 'packages/studio/scripts/'],
  },
  {
    id: 'E06',
    track: 'E — gates & harness',
    title: 'Operational scripts and probes',
    focus: 'Scripts an operator runs against a live instance.',
    // Deliberately NOT a `scripts/` prefix: a prefix here would swallow every
    // gate added later and file it as an ops probe, reviewed against the wrong
    // checklist. Listed one by one so a new script fails the generator instead.
    match: [
      'scripts/bench-concurrency.ts',
      'scripts/bootstrap-db-role.sh',
      'scripts/dr-drill.sh',
      'scripts/enable-all-extensions.ts',
      'scripts/fire-test.sh',
      'scripts/generate-compose.sh',
      'scripts/generate-versions-json.sh',
      'scripts/install.sh',
      'scripts/probe-ext-auth.ts',
      'scripts/probe-sdui-endpoints.ts',
      'scripts/report-slow-in-transaction.ts',
      'scripts/seed-demo.ts',
      'scripts/setup-test-db.sh',
      'scripts/sql/',
      'scripts/sync-engine-version.ts',
      'scripts/validate-all-extensions.ts',
      'scripts/backfill-i18n-prefixes.ts',
    ],
  },
  {
    id: 'E07',
    track: 'E — gates & harness',
    title: 'End-to-end suite, shared harness, benchmarks',
    focus:
      'What e2e actually exercises, what the harness boots, and whether a benchmark measures ' +
      'the thing it names.',
    match: ['e2e/', 'bench/', 'playwright.config.ts', `${E}testing/`],
  },

  {
    id: 'E08',
    track: 'E — gates & harness',
    title: 'CI workflows',
    focus:
      'Which gate actually runs, on which event, and which job is allowed to fail. A gate ' +
      'that runs nowhere is a comment.',
    match: ['.github/'],
  },
  {
    id: 'E09',
    track: 'E — gates & harness',
    title: 'Containers, chart, installer, observability',
    focus: 'What an operator actually deploys: image, compose, Helm values, bare-metal installer.',
    match: [
      'charts/',
      'install/',
      'docker/',
      'observability/',
      'grafana/',
      'demo/',
      'Dockerfile',
      'docker-compose.yml',
      'docker-compose.dev.yml',
      'docker-compose.ai.yml',
      'docker-compose.electric.yml',
      'prometheus.yml',
      'render.yaml',
      'fly.toml',
      'railway.json',
    ],
  },

  // ── Track T — the test corpus ────────────────────────────────────────────
  {
    id: 'T01',
    track: 'T — tests',
    title: 'Test corpus',
    focus:
      'Reviewed inside the owning section, not on its own: every session records which test ' +
      'files it opened. What stays unrecorded is the backlog nobody has read.',
    match: [],
  },
];

/**
 * Priority order. The campaign is worked strictly down this list — the generator
 * names the next open section so nobody has to decide, and so two agents on two
 * machines pick the same one.
 *
 * Phase 0 is not code: it is finding out which gates actually run, and which of
 * them report clean when their input is missing. Everything after inherits that
 * answer, so it is cheap and it goes first.
 */
const ORDER: string[] = [
  // Phase 0 — what enforcement actually exists.
  'E01',
  'E02',
  'E04',
  'E08',
  // Phase 1 — isolation and authorisation. The class with proven leaks.
  'A04',
  'A05',
  'A06',
  'A02',
  'A07',
  'A16',
  'A11',
  // Phase 2 — data integrity.
  'A08',
  'A09',
  'A10',
  'A12',
  'A13',
  'A14',
  'A15',
  'A17',
  'A01',
  'A03',
  // Phase 3 — the code that runs other people's code.
  'B03',
  'B01',
  'B02',
  'B04',
  'B05',
  // Phase 4 — subsystems that report outcomes.
  'B10',
  'B08',
  'B11',
  'B12',
  'B06',
  'B07',
  'B09',
  'B13',
  // Phase 5 — surfaces.
  'C01',
  'C02',
  'C03',
  'C04',
  'C05',
  'C06',
  'C07',
  'C08',
  'C09',
  'C10',
  'C11',
  'C12',
  'C13',
  'C14',
  'D01',
  'D02',
  'D03',
  'D04',
  'D05',
  'D06',
  'D07',
  // Phase 6 — the rest of the harness.
  'E03',
  'E05',
  'E06',
  'E07',
  'E09',
];

// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_EXT = /(\.(tsx?|jsx?|svelte|sql|sh|ya?ml)$|(^|\/)Dockerfile[^/]*$)/;
const IS_TEST = /(\.test\.|\.spec\.)|\/tests?\//;

async function trackedFiles(): Promise<string[]> {
  const proc = Bun.spawn(['git', 'ls-files'], { stdout: 'pipe' });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error('git ls-files failed');
  return out.split('\n').filter((f) => f && SOURCE_EXT.test(f) && !f.startsWith('release/'));
}

function sectionFor(file: string): Section | undefined {
  // e2e specs belong to their own section, not to the test corpus.
  if (IS_TEST.test(file) && !file.startsWith('e2e/')) {
    return SECTIONS.find((s) => s.id === 'T01');
  }
  return SECTIONS.find((s) =>
    s.match.some((m) => (m.endsWith('/') ? file.startsWith(m) : file === m)),
  );
}

/** Files git knows about but the working tree does not — a staged deletion, or
 *  a mid-merge state. Counted as zero rather than crashing the whole run: this
 *  script is read in shared checkouts while somebody else is editing. */
const missingOnDisk: string[] = [];

async function lineCount(file: string): Promise<number> {
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch {
    missingOnDisk.push(file);
    return 0;
  }
  const n = text.split('\n').length;
  // A trailing newline is a terminator, not an empty last line — match `wc -l`,
  // because these numbers get compared against it.
  return text.endsWith('\n') ? n - 1 : n;
}

async function main() {
  const files = await trackedFiles();
  const loc = new Map<string, number>();
  await Promise.all(files.map(async (f) => loc.set(f, await lineCount(f))));

  const bySection = new Map<string, string[]>();
  const unassigned: string[] = [];
  for (const f of files) {
    const s = sectionFor(f);
    if (!s) {
      unassigned.push(f);
      continue;
    }
    if (!bySection.has(s.id)) bySection.set(s.id, []);
    bySection.get(s.id)!.push(f);
  }

  // One file per session, not one array for all of them.
  //
  // The single `code-review-status.json` conflicted on EVERY section branch —
  // four times in the first day — because each section appends to the same
  // array, and each resolution was a hand-merge of a findings document. A
  // hand-merge that happens on every branch eventually drops a section.
  //
  // A directory has no such conflict: two branches write two filenames. The old
  // file is still read when present, so an in-flight branch that has not
  // migrated is not lost.
  const sessions: SessionEntry[] = [];
  let updated = 'never';
  const legacy = await Bun.file(STATUS_JSON)
    .json()
    .catch(() => null);
  if (legacy?.sessions) {
    sessions.push(...(legacy.sessions as SessionEntry[]));
    updated = legacy.updated ?? updated;
  }
  for (const f of await Array.fromAsync(new Bun.Glob('*.json').scan(SESSIONS_DIR)).catch(
    () => [] as string[],
  )) {
    const one = await Bun.file(`${SESSIONS_DIR}/${f}`)
      .json()
      .catch(() => null);
    if (!one?.section) continue;
    // A ledger entry missing `files` used to reach the loop below and come back
    // as `undefined is not an object (evaluating 's.files')` — a stack trace
    // naming the generator, with nothing naming the file that caused it. Written
    // by hand once per session, so a missing field is the ordinary case, not the
    // exotic one; say which file and what is absent.
    if (!Array.isArray(one.files)) {
      console.error(`[review-inventory] ${SESSIONS_DIR}/${f} has no "files" array.`);
      console.error('Every session entry must list the files it read, even if empty.');
      process.exit(1);
    }
    sessions.push(one as SessionEntry);
  }
  const ledger: Ledger = { updated, sessions };

  const sessionsBySection = new Map<string, SessionEntry[]>();
  const reviewed = new Set<string>();
  const testsRead = new Set<string>();
  for (const s of ledger.sessions) {
    if (!sessionsBySection.has(s.section)) sessionsBySection.set(s.section, []);
    sessionsBySection.get(s.section)!.push(s);
    for (const f of s.files) reviewed.add(f);
    for (const t of s.tests ?? []) testsRead.add(t);
  }

  const inScope = (id: string) => !id.startsWith('X') && id !== 'T01';
  const sum = (fs: string[]) => fs.reduce((n, f) => n + (loc.get(f) ?? 0), 0);

  const md: string[] = [];
  md.push('# Code review campaign — state');
  md.push('');
  md.push('> Generated by `scripts/review-inventory.ts` (`bun run review:inventory`).');
  md.push('> **Do not edit by hand.** Record your session in');
  md.push(`> [\`code-review-status.json\`](./code-review-status.json) and re-run the script.`);
  md.push('> The method — what counts as reviewed — is in');
  md.push('> [`CODE-REVIEW-CAMPAIGN.md`](./CODE-REVIEW-CAMPAIGN.md). Read it first.');
  md.push('');
  // No wall-clock stamp: three sessions share this checkout, and a timestamp
  // made every re-run a git modification even when nothing had changed.
  // The file is now a pure function of the ledger and the tree.
  md.push(`Ledger updated: ${ledger.updated}`);
  md.push('');

  // ── Summary ──
  const scoped = SECTIONS.filter((s) => inScope(s.id));
  const scopedFiles = scoped.flatMap((s) => bySection.get(s.id) ?? []);
  const doneFiles = scopedFiles.filter((f) => reviewed.has(f));
  const pct =
    scopedFiles.length === 0 ? 0 : Math.round((doneFiles.length / scopedFiles.length) * 100);
  const locPct = sum(scopedFiles) === 0 ? 0 : Math.round((sum(doneFiles) / sum(scopedFiles)) * 100);

  // ── Next up ──
  // A section is open until every file in it carries a tick. `partial` sessions
  // therefore leave it at the front of the queue, which is what we want.
  const missingFromOrder = scoped.filter((s2) => !ORDER.includes(s2.id)).map((s2) => s2.id);
  const openness = (id: string) => {
    const fs2 = bySection.get(id) ?? [];
    const done2 = fs2.filter((f) => reviewed.has(f));
    return { total: fs2.length, done: done2.length, open: done2.length < fs2.length };
  };
  const queue = ORDER.filter((id) => openness(id).open);
  const next = queue[0];
  const testsLeft = (bySection.get('T01') ?? []).filter((t) => !testsRead.has(t)).length;

  md.push('## Next up');
  md.push('');
  if (next) {
    const s2 = SECTIONS.find((x) => x.id === next)!;
    const o = openness(next);
    md.push(`### → **${next} — ${s2.title}**`);
    md.push('');
    md.push(`*${s2.focus}*`);
    md.push('');
    md.push(
      `${o.total - o.done} of ${o.total} files still unread. ` +
        `Its file list is under [\`${next}\`](#${next.toLowerCase()}--${s2.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/-+$/, '')}) below.`,
    );
    md.push('');
    if (queue.length > 1) md.push(`After it: ${queue.slice(1, 5).join(', ')} …`);
    md.push('');
  } else if (testsLeft > 0) {
    md.push(`### → **T01 — the test files nobody opened** (${testsLeft} left)`);
    md.push('');
    md.push('Every section is closed. What remains is the test corpus no session touched.');
    md.push('');
  } else {
    md.push('### Nothing open. The campaign is complete.');
    md.push('');
  }
  if (missingFromOrder.length > 0) {
    md.push(
      `⛔ Not in the priority order: ${missingFromOrder.join(', ')} — ` +
        'add them to `ORDER` in `scripts/review-inventory.ts`.',
    );
    md.push('');
  }

  md.push('## Progress');
  md.push('');
  md.push(`- Sections in scope: **${scoped.length}**`);
  md.push(`- Files in scope: **${doneFiles.length} / ${scopedFiles.length}** (${pct}%)`);
  md.push(
    `- Lines in scope: **${sum(doneFiles).toLocaleString()} / ` +
      `${sum(scopedFiles).toLocaleString()}** (${locPct}%)`,
  );
  const allTests = bySection.get('T01') ?? [];
  md.push(
    `- Test files opened by some session: **${allTests.filter((t) => testsRead.has(t)).length} ` +
      `/ ${allTests.length}**`,
  );
  md.push('');

  if (missingOnDisk.length > 0) {
    md.push('## ⚠️ Tracked but absent from the working tree');
    md.push('');
    md.push('Counted as zero lines. Usually a staged deletion or a half-finished merge —');
    md.push('the line and coverage numbers below are understated until it resolves.');
    md.push('');
    for (const f of missingOnDisk.sort()) md.push(`- \`${f}\``);
    md.push('');
  }

  if (unassigned.length > 0) {
    md.push('## ⛔ UNASSIGNED — the campaign has a hole');
    md.push('');
    md.push('These tracked files match no section. Add them to `scripts/review-inventory.ts`');
    md.push('before claiming any coverage number below.');
    md.push('');
    for (const f of unassigned) md.push(`- \`${f}\``);
    md.push('');
  }

  // ── Per-track table ──
  const tracks = [...new Set(SECTIONS.map((s) => s.track))];
  md.push('## Sections');
  md.push('');
  for (const track of tracks) {
    md.push(`### ${track}`);
    md.push('');
    md.push('| # | Section | Files | Lines | Reviewed | Last session |');
    md.push('| --- | --- | --: | --: | --: | --- |');
    for (const s of SECTIONS.filter((x) => x.track === track)) {
      const fs = bySection.get(s.id) ?? [];
      const done = fs.filter((f) => reviewed.has(f));
      const sess = sessionsBySection.get(s.id) ?? [];
      const last =
        sess.length > 0 ? `${sess[sess.length - 1].date} — ${sess[sess.length - 1].verdict}` : '—';
      const mark = !inScope(s.id) ? 'n/a' : `${done.length}/${fs.length}`;
      md.push(
        `| ${s.id} | ${s.title} | ${fs.length} | ${sum(fs).toLocaleString()} | ${mark} | ${last} |`,
      );
    }
    md.push('');
  }

  // ── Per-section detail ──
  md.push('---');
  md.push('');
  md.push('## Section detail');
  md.push('');
  for (const s of SECTIONS) {
    const fs = bySection.get(s.id) ?? [];
    md.push(`### ${s.id} — ${s.title}`);
    md.push('');
    md.push(`*${s.focus}*`);
    md.push('');
    if (s.id === 'T01') {
      const unread = fs.filter((t) => !testsRead.has(t));
      const byDir = new Map<string, number>();
      for (const t of unread) {
        const d = t.split('/').slice(0, -1).join('/');
        byDir.set(d, (byDir.get(d) ?? 0) + 1);
      }
      md.push(`Test files nobody has opened yet: **${unread.length}** of ${fs.length}.`);
      md.push('');
      md.push('| Directory | Unread |');
      md.push('| --- | --: |');
      for (const [d, n] of [...byDir].sort((a, b) => b[1] - a[1])) {
        md.push(`| \`${d}\` | ${n} |`);
      }
      md.push('');
      continue;
    }
    if (!inScope(s.id)) {
      md.push(
        `${fs.length} files, ${sum(fs).toLocaleString()} lines. Not reviewed in this campaign.`,
      );
      md.push('');
      continue;
    }
    md.push('| ✓ | File | Lines |');
    md.push('| --- | --- | --: |');
    for (const f of fs.sort()) {
      md.push(`| ${reviewed.has(f) ? '✅' : '·'} | \`${f}\` | ${loc.get(f)} |`);
    }
    md.push('');
    const sess = sessionsBySection.get(s.id) ?? [];
    if (sess.length > 0) {
      md.push('**Sessions**');
      md.push('');
      for (const e of sess) {
        md.push(
          `- **${e.date}** · ${e.agent} · ${e.files.length} files · **${e.verdict}**` +
            (e.branch ? ` · \`${e.branch}\`` : ''),
        );
        for (const r of e.ran ?? []) md.push(`  - ran: ${r}`);
        for (const f of e.findings ?? []) {
          md.push(
            `  - **${f.severity}** ${f.where} — ${f.what} → *${f.status}*` +
              (f.ref ? ` (${f.ref})` : ''),
          );
        }
        if (e.notDone) md.push(`  - not done: ${e.notDone}`);
      }
      md.push('');
    }
  }

  await Bun.write(OUTPUT_MD, `${md.join('\n')}\n`);

  console.log(
    `${OUTPUT_MD}: ${scoped.length} sections, ` +
      `${doneFiles.length}/${scopedFiles.length} files reviewed (${pct}%).`,
  );
  console.log(next ? `NEXT SECTION: ${next}` : `NEXT SECTION: T01 (${testsLeft} test files left)`);
  if (missingFromOrder.length > 0) {
    console.error(`Sections missing from ORDER: ${missingFromOrder.join(', ')}`);
    process.exit(1);
  }
  if (unassigned.length > 0) {
    console.error(`\n${unassigned.length} tracked files match no section:`);
    for (const f of unassigned) console.error(`  ${f}`);
    process.exit(1);
  }
}

await main();
