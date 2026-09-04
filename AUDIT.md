# Zveltio Full Codebase Audit

**Branch:** `agent/full-codebase-audit`  
**Started:** 2026-09-04  
**Scope:** Complete codebase audit across engine, studio, SDK, CLI, and first-party extensions.  
**Approach:** One branch, one living document. Fixes applied only when necessary to validate better code variants or close clear defects.

---

## Overall Status

| Session | Topic | Reading | Fixes | Landed in |
|---------|-------|---------|-------|-----------|
| 1 | Engine bootstrap & request lifecycle | done, 12 observations | 1 applied, 2 open | `e92fdc42` |
| 2 | Tenancy, RLS & security | done, 17 observations | 2 applied | `d12b6480`, `333db6b6` |
| 3 | Data layer (collections, DDL, ghost DDL, write pipeline) | done, 16 observations | 1 applied | `d12b6480` |
| 4 | Extensions & sandbox | done, 15 observations | 1 applied | `e92fdc42` |
| 5 | Auth & sessions | done, 12 observations | none needed | — |
| 6 | Background services (flows, webhooks, realtime, cron) | done, 10 observations | none needed | — |
| 7 | Storage & AI integrations | done, 7 observations | 1 applied | `e92fdc42` |
| 8 | Studio & SDUI | done, 8 observations | 2 applied | `e92fdc42` |
| 9 | SDK & CLI public surface | done, 6 observations | none needed | — |
| 10 | zveltio-extensions catalog | done, 8 observations | none needed | — |

**The table said "Pending" for sessions 3 to 10 while all ten were written, and
"unstaged" for session 1 after it had been committed.** Corrected 2026-09-04
against the sections below and the branch. A status table that disagrees with its
own document is the defect this audit exists to find, so it is worth naming.

**What "done" means here, and what it does not.** The observations are code
reading. The `Verification` blocks are real — lint, typecheck, test suites and,
for session 10, the sibling repository's own gates — but they check that the
tree still builds, not that the behaviour described in each observation was
exercised. Under the rule in
[`docs/private/CODE-REVIEW-CAMPAIGN.md`](docs/private/CODE-REVIEW-CAMPAIGN.md)
— *do not believe anything you have not seen run* — this document is a map of
the codebase, not coverage of it. The sections it names remain unreviewed in
[`CODE-REVIEW-STATE.md`](docs/private/CODE-REVIEW-STATE.md), deliberately.
---

## Session 1 — Engine Bootstrap & Request Lifecycle

**Goal:** Understand how the engine starts, how middleware is ordered, how requests reach handlers, and identify any obvious ordering bugs, dead routes, or footguns.

### Files inspected

- `packages/engine/src/index.ts`
- `packages/engine/src/routes/index.ts`
- `packages/engine/src/lib/startup-guards.ts`
- `packages/engine/src/db/index.ts`
- `packages/engine/src/db/migrate.ts`
- `packages/engine/src/middleware/tenant.ts`
- `packages/engine/src/middleware/extension-auth-gate.ts`
- `packages/engine/src/middleware/session-prefetch.ts`
- `packages/engine/src/lib/runtime/cron-runner.ts`

### Observations

1. **Middleware order matches the documented lifecycle.** `buildHonoApp()` registers:
   `trailingSlashRedirect` → `logger` → `problemOnError`/`problemNormalizer` → `enrichDenial` → `bodyLimit` → `cors` → `sessionPrefetch` → `tenantMiddleware` → `tenantMembershipMiddleware` → `extensionAuthGate` → `extRateLimit` → routes.
   The fail-closed extension gate is mounted **after** tenant isolation, as required.

2. **Session prefetch runs before tenant transaction.** This is critical: Better-Auth tables are not readable by `zveltio_rls`, so resolving the session inside the transaction aborts it. Code correctly resolves `isGodUser` and `resolveUserRole` here too, avoiding second-pool-checks inside the transaction.

3. **Production guards are strict and well-scoped.** `assertProductionConfig()` refuses production boot when:
   - `ZVELTIO_EXT_AUTH_GATE=0`
   - `VALKEY_URL` unset (without `ZVELTIO_ALLOW_NO_CACHE=1`)
   - `CORS_ORIGINS=*`
   Documented gap: `CORS_ORIGINS` completely unset is still accepted in production.

4. **Pool sizing logic is centralized.** `DEFAULT_DB_POOL_MAX = 40` in `db/index.ts`, autosizing reads `max_connections` unless disabled, and `reportConcurrencyCeiling()` prints the arithmetic at boot.

5. **Tenant transaction skip-list is justified.** `TXN_SKIP_PREFIXES` includes routes that run on `poolDb` (`/api/insights`, `/api/flows`, `/api/backup`, `/api/admin/sql`) plus schema/tenant/auth health routes. `check:pooldb-txn` gate is supposed to keep this in sync with `routes/index.ts`.

6. **Shutdown is incomplete.** `shutdown()` stops `webhookWorker`, `flowScheduler`, DDL queue, and realtime bus, but:
   - it never calls `_server?.stop()`;
   - it never calls `cronRunner.stop()`;
   - `realtimeBus().stop()` is fire-and-forget (`.catch` only) right before `process.exit(0)`, so async cleanup has no time to finish.
   This can drop in-flight requests and leave cron/webhook jobs mid-run.

7. **Metrics middleware placement is inconsistent.** The request-counting middleware is registered **after** `/api/extensions`, `/health`, and `/metrics`. The comment says it skips self-monitoring endpoints, but `/api/extensions` is not listed and is also excluded because of ordering. Either the comment is stale or the middleware should move above `/api/extensions`.

8. **Stale comment in `routes/index.ts`.** Header still lists `/api/ai/*` as a core route, but AI was moved to the `ai` extension. This is the docs drift noted in `ZVELTIO-VS-SUPABASE-AND-BOUNDARY-AUDIT.md` §4.4.

9. **`migrate` CLI command only runs core migrations.** It calls `initDatabase()` which runs `runCoreMigrations()`, but it does not run `autoMigrate()` or extension migrations. Since extension migrations run at boot inside `extensionLoader.loadAll/loadFromDB`, a manual `zveltio migrate` may leave an extension schema behind until the next `start`. This is likely intentional, but worth documenting clearly.

10. **Static file serving looks correct.** `getContentType()` handles query strings and no-query cases correctly; directory-traversal guard normalizes both separators. Minor inconsistency: `serveEmbeddedStudio` only checks for `..`, while `serveStaticFile` does a resolved-path prefix check. For an in-memory embed the risk is negligible.

11. **Default extensions auto-activation is hardcoded.** `ensureDefaultExtensions()` activates `content/pages` and `ai` if present on disk. This couples boot to two first-party extensions. Fine for the official distribution, but a different fork would need to edit source.

12. **`_bootstrapCtx` uses explicit `any`.** Tracked in `docs/private/HARDENING-9-PLAN.md` H-01; not a new issue.

### Fixes / experiments

- [x] **Fix graceful shutdown** — `packages/engine/src/index.ts` now calls `cronRunner.stop()`, awaits `realtimeBus().stop()`, and calls `_server?.stop()` before `process.exit(0)`. Verified with `bun x biome check packages/engine/src/index.ts` and `cd packages/engine && bun run typecheck`.
- [ ] **Clarify metrics middleware scope** — either move it above `/api/extensions` or update the skip comment.
- [ ] **Remove stale `/api/ai/*` comment** in `routes/index.ts` header.

### TODOs

- [x] Confirm middleware order matches documented sequence.
- [ ] Identify any routes shadowed by `:param` routes.
- [ ] Check production guards for completeness.

---

---

## Session 2 — Tenancy, RLS & Security

**Goal:** Understand tenant resolution, Postgres RLS enforcement, Casbin RBAC, row-rule policies, column permissions, and denial messages; identify any drift or unsafe fallbacks.

### Files inspected

- `packages/engine/src/lib/tenancy/index.ts`
- `packages/engine/src/lib/tenancy/tenant-context.ts`
- `packages/engine/src/lib/tenancy/tenant-manager.ts`
- `packages/engine/src/lib/tenancy/tenant-scope.ts`
- `packages/engine/src/lib/tenancy/rls.ts`
- `packages/engine/src/lib/tenancy/row-rule-policy.ts`
- `packages/engine/src/lib/tenancy/rule-operators.ts`
- `packages/engine/src/lib/tenancy/permissions.ts`
- `packages/engine/src/lib/tenancy/resource-grants.ts`
- `packages/engine/src/lib/tenancy/entity-access.ts`
- `packages/engine/src/lib/tenancy/column-permissions.ts`
- `packages/engine/src/lib/tenancy/denial.ts`
- `packages/engine/src/lib/tenancy/fail-closed-tenant.ts`
- `packages/engine/src/lib/tenancy/signed-cache.ts`

### Observations

1. **Tenant transaction isolation is well-architected.** `withTenantIsolation` opens a transaction, drops to `zveltio_rls`, publishes tenant/reach/identity GUCs, and binds the transaction into AsyncLocalStorage via `runWithTenantTrx`. The proxy `createRequestScopedDb` resolves the scoped transaction for `ctx.db`, counts dangerous unscoped fallbacks, and joins nested `.transaction()` calls to the existing transaction.

2. **`runWithTenantTrx` correctly creates a new ALS store instead of mutating.** The extensive comment documents a real cross-tenant leak caused by a synchronous `finally` restoring a mutated field before the async handler finished.

3. **RLS predicates are centralized in SQL functions.** `applyTenantRLS` and the extension reconciler both use `zveltio_visible_tenants()` / `zveltio_tenant_scope_ok()` for reads and `zveltio_tenant_write_ok()` for writes, avoiding inline predicate drift. The `(SELECT fn())::uuid[]` wrapper turns the array into an InitPlan for better planning.

4. **Row-rule semantics are centralized in `rule-operators.ts`.** Four appliers (Kysely WHERE, SQL policy predicate, in-memory matcher, jsonb snapshot) now read the same operator definitions and the same NULL-drop rule. The file is a good example of fixing drift with a single source of semantic truth.

5. **Permission caches are signed and fail-closed.** God-role, user-role, roles, permission results, tenant rows, RLS policies, and column permissions all use HMAC-SHA256 keyed on `BETTER_AUTH_SECRET`. Tampered entries decode to `null` and fall back to the DB rather than granting access.

6. **Casbin model is deny-by-default with total wildcard only when `obj='*' AND act='*'`.** Partial wildcards like `('tenant_member', '*', '*', 'read')` no longer grant anything; migration 034 and `materializeDefaultGrants` expand them into explicit per-resource rows. The adapter correctly uses `Helper.loadPolicyLine` and saves both `p` and `g` sections.

7. **`effectivePermissions` precomputes a user's permission set to replace expensive denial scans.** It uses `getImplicitRolesForUser` (which honours the domain wildcard) and scans loaded policies once per (domain, user). A test seam `__allowViaSet` holds it against `enforce()`.

8. **`requireInstanceAdmin` correctly restricts the bare `admin` permission to the root tenant or god role.** Without this, a delegated `tenant_admin` could reach instance-wide admin tools.

9. **Denial messages are user-actionable.** `describeDenial` returns structured data with up to three granter names, never email addresses, so Studio/CLI can translate. `whoCanGrant` queries `zvd_permissions` for `tenant_owner`/`tenant_admin` in the current domain or `*`.

10. **`resource-grants.ts` used `node:fs` directly.** AGENTS.md prefers Bun APIs (`Bun.file`). The reads are safe and local, but the file was inconsistent with repo conventions.

11. **`enableRLS` in `tenant-manager.ts` did not set a column default for `tenant_id`.** It adds the column with a FK but no default, so future INSERTs without an explicit `tenant_id` become NULL and are invisible to every tenant. `applyTenantRLS` sets `COALESCE(NULLIF(current_setting(...), '')::uuid, default-tenant)`; `enableRLS` should match it.

12. **`enableRLS` uses `REFERENCES zv_tenants(id) ON DELETE CASCADE` while `applyTenantRLS` does not.** This is a deliberate difference for external tables, but the missing default is the inconsistency that affects writes.

13. **`tenant-manager.ts` contains legacy `as any` casts** in `getTenantBySlug`, `getTenantById`, `getUserTenants`, and `provisionEnvironment`. These are tracked under `docs/private/HARDENING-9-PLAN.md` H-01.

14. **`fail-closed-tenant.ts` uses `sql.raw` with a regex-validated database name.** This is unavoidable for `ALTER DATABASE ... SET`, and the validation (`/^[a-zA-Z0-9_]+$/`) is sufficient to prevent identifier injection.

15. **`column-permissions.ts` correctly treats `hidden` and `readOnly` separately.** `applyColumnAccess` only hides; `filterWritableFields` only blocks writes. The wildcard `'*'` is honoured in both. Cache invalidation scans matching keys and drops the query cache for the collection.

16. **`entity-access.ts` registry is scoped per extension and cleaned up on unload.** First explicit `deny` wins; no checks means allow; `hasChecksFor` avoids N awaits on unrestricted tables.

17. **Tenant scope resolution distinguishes "never enrolled" (`visible: null`) from "enrolled but expired" (`visible: [NO_UNITS]`).** This keeps god users, API keys, and single-tenant installs on the equality fallback while locking out expired assignments.

### Fixes / experiments

- [x] **Use `Bun.file` in `resource-grants.ts`** — replaced `node:fs` `existsSync`/`readFileSync` with `await Bun.file(...).exists()` and `await Bun.file(...).text()`. Verified with `bun x biome check` and `bun run typecheck`.
- [x] **Add `tenant_id` default in `enableRLS`** — aligned with `applyTenantRLS` so INSERTs without an explicit tenant land in the current tenant instead of becoming NULL/orphan rows. Verified with `bun x biome check` and `bun run typecheck`.

### TODOs

- [x] Confirm tenant transaction order and RLS role downgrade.
- [x] Verify row-rule / RLS operator consistency across appliers.
- [ ] Check whether `provisionTenantSchema` / environment schemas are actually used by the data layer.
- [ ] Audit middleware/tenant.ts and routes/admin permissions in a later session.

---

## Session 3 — Data Layer

**Goal:** Understand the collection/DDL lifecycle, the CRUD write/read pipeline, field-type registry, query cache, ghost DDL, and dynamic SQL boundary.

### Files inspected

- `packages/engine/src/lib/data/index.ts`
- `packages/engine/src/lib/data/types.ts`
- `packages/engine/src/lib/data/auth.ts`
- `packages/engine/src/lib/data/ddl-manager.ts`
- `packages/engine/src/lib/data/ddl-queue.ts`
- `packages/engine/src/lib/data/ghost-ddl.ts`
- `packages/engine/src/lib/data/write-pipeline.ts`
- `packages/engine/src/lib/data/shape.ts`
- `packages/engine/src/lib/data/query-cache.ts`
- `packages/engine/src/lib/data/field-type-registry.ts`
- `packages/engine/src/lib/data/field-crypto.ts`
- `packages/engine/src/db/dynamic.ts`
- `packages/engine/src/lib/route-db.ts`

### Observations

1. **Data subsystem barrel re-exports pipeline helpers explicitly.** `processInput`, `afterWrite`, `validateApiKey`, `checkAccess`, `serializeRecord`, `normalizeFields` are named exports so the H-05 split does not introduce name collisions.

2. **`DEFAULT_TENANT_ID` was defined twice.** `lib/route-db.ts` and `lib/tenancy/tenant-manager.ts` both exported the same sentinel UUID. Any future change risked divergence. `route-db.ts` now re-exports the value from `tenant-manager.ts`.

3. **Postgres errors are mapped to structured HTTP responses in `write-pipeline.ts`.** `mapPgError` covers 42501 (RLS → 403), 23503 (FK → 422), 23505 (unique → 409), 23502 (NOT NULL → 422), 23514 (check → 422), 22P02 (invalid value → 422), 42703 (unknown column → 422). `describeWriteRefusal` names both tenancy and row-rule causes honestly.

4. **`afterWrite` coordinates post-write side effects.** Revisions, webhooks, realtime, query-cache invalidation, flows, and `engineEvents.emitAsync` are all awaited or fire-and-forget with logging. Revisions are inserted as an object so the `jsonb` column stores a real object, not a double-encoded string.

5. **`processInput` validates and deserializes through the field-type registry.** Unknown field types are no longer silently skipped; validation rules from `zv_validation_rules` are evaluated fail-closed.

6. **`auth.ts` `validateApiKey` enforces tenant scoping and publishes the actor.** A key issued in tenant A cannot authenticate a request acting in tenant B unless it is a root-tenant key. `publishApiKeyActor` writes the identity GUCs onto the request transaction so row-rule policies apply to API-key traffic.

7. **`DDLManager` is careful with identifiers and transactions.** Collection/field names are regex-validated. Relation FKs and junction tables are handled separately. `CREATE INDEX CONCURRENTLY` is refused inside a transaction. Tenant RLS defaults and composite indexes are created consistently. `materializeDefaultGrants` runs after metadata registration.

8. **DDL queue uses pg-boss.** Per-type queues, retry/backoff, DLQ, and a recovery pass for invalid indexes. Test mode polls until the job settles.

9. **Ghost DDL implements a PlanetScale-style online migration.** `isAllowedGhostDdl` is anchored and rejects injection. Changelog trigger captures live mutations; batch copy uses `RETURNING id`; atomic swap locks and renames. `sweepGhostOrphans` reclaims leftovers at boot. `cancelPendingCleanups()` is already wired into graceful shutdown.

10. **Field crypto uses AES-256-GCM with base64url encoding.** `maybeEncrypt` is fail-closed: a field marked `encrypted: true` refuses to write plaintext unless `ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS=1` is set.

11. **Query cache is tenant-scoped but not signed.** Keys are `qc:{tenant}:{collection}:{hash}`; invalidation can target a tenant/collection or a user. The cached payload is already RLS-filtered and column-masked, so integrity is delegated to the cache ACL.

12. **`shape.ts` `applyExpand` gates reads on the target collection.** It calls `checkPermission`, applies RLS filters, and applies column permissions + `_label` derivation from visible fields only.

13. **`field-type-registry.ts` `renderSqlDefault` is hardened.** Only known SQL expressions (`now()`, `gen_random_uuid()`, etc.) are emitted verbatim; everything else becomes a quoted string literal.

14. **`db/dynamic.ts` is the single dynamic-query boundary.** `buildCondition` handles all filter operators in one place so cursor pagination and RLS filters cannot drift. `tenantScopeId` is documented as a performance-only addition.

15. **Minor: `afterWrite`'s comment says it "runs on the pool, not the request transaction," but callers pass `reqDb(c, db)` which may be the tenant transaction.** The behaviour is correct; the comment is misleading.

16. **Minor: `validateApiKey` updates `last_used_at` fire-and-forget.** If the passed `db` is a request transaction, the update is queued on that connection; it usually commits, but it is not awaited and errors are only logged.

### Fixes / experiments

- [x] **Centralize `DEFAULT_TENANT_ID`** — `lib/route-db.ts` now re-exports the sentinel from `lib/tenancy/tenant-manager.ts` instead of defining its own copy. Verified with `bun x biome check` and `bun run typecheck`.

### TODOs

- [x] Confirm data subsystem exports are collision-free.
- [x] Verify field encryption fail-closed posture.
- [ ] Review `query-parse.ts`, `query-utils.ts`, `query-alter.ts`, and `time-travel-count.ts` in a follow-up pass.
- [ ] Check whether `afterWrite` should always receive the pool handle, or whether callers should be explicit.

---

## Session 4 — Extensions & Sandbox

**Goal:** Understand extension loading, registration, sandboxing, worker isolation, capability gating, and table-access controls.

### Files inspected

- `packages/engine/src/lib/extensions/index.ts`
- `packages/engine/src/lib/extensions/extension-loader.ts`
- `packages/engine/src/lib/extensions/register.ts`
- `packages/engine/src/lib/extensions/extension-context.ts`
- `packages/engine/src/lib/extensions/extension-sandbox.ts`
- `packages/engine/src/lib/extensions/worker-extension-host.ts`
- `packages/engine/src/lib/extensions/capabilities.ts`
- `packages/engine/src/lib/extensions/consent.ts`
- `packages/engine/src/lib/extensions/manifest-schema.ts`
- `packages/engine/src/lib/extensions/lifecycle.ts`
- `packages/engine/src/lib/extensions/load.ts`
- `packages/engine/src/lib/extensions/discovery.ts`
- `packages/engine/src/lib/extensions/migration-runner.ts`

### Observations

1. **Extension subsystem is well modularised after the H-04 split.** Loader, lifecycle, register, load, discovery, manifest schema, sandbox, and worker host each have a focused file. The barrel re-exports the public surface.

2. **`createRestrictedDb` in `extension-context.ts` uses an allowlist, not a prefix denylist.** It permits `zvd_*` user tables, the extension's own `zv_<extname>_*` namespace, and explicit grants. This closed the leak where `session`, `account`, `verification`, and other unprefixed Better-Auth tables were readable by extensions.

3. **Extension writes against `zvd_*` run through the same field pipeline as HTTP writes.** `wrapInsertForHooks` / `wrapUpdateForHooks` deserialize, validate, encrypt, and fire `record.before*` hooks. Bulk updates/deletes skip hooks with a warning but still run the field pipeline.

4. **`ctx.db` is tenant-scoped via `getCurrentTenantTrx()`** in `buildRestrictedContext`. Extensions no longer receive a raw pool handle that would let them read across tenants.

5. **`ctx.adminDb` is capability-gated (`db:admin`).** Without the capability it throws, making cross-tenant access visible at review/install time.

6. **`engineOwnedTables()` derives protected tables from the engine's own migration SQL** (disk or embedded). New engine tables are automatically protected; no manual list to maintain.

7. **`EXTENSION_TABLE_GRANTS` is the explicit escape hatch** for extensions that legitimately need an engine table. The comments document why each entry exists and when it can be removed.

8. **`registerExtensionRoutes` propagates `problemOnError` onto extension sub-apps.** Because extensions bundle their own Hono copy, the parent's error handler would not apply by identity. Setting `sub.onError(problemOnError)` fixes the branch Hono actually takes.

9. **Worker isolation host (`worker-extension-host.ts`) spawns one `Bun.Worker` per extension.** It limits the worker's env to `{ NODE_ENV }`, rebinds the Hono app on hot-reload, tracks in-flight tenants host-side, randomises RPC ids, and has heartbeat + crash respawn logic.

10. **Capabilities and quotas are defined in `extension-sandbox.ts`.** First-party extensions get broader defaults; third-party are restricted. Overrides via `EXTENSION_POLICIES_JSON`. `policyFor` fails closed: unknown extensions get third-party defaults.

11. **Hot-reload coalesces overlapping rebuilds** in `extension-loader.ts` and persists isolation/capability decisions so a worker-isolated extension does not silently downgrade to inline after enable/disable.

12. **`extensionListeners` cleanup prevents listener duplication** on hot-reload. `unregisterExtensionListeners` is called when building the restricted context.

13. **Manifest schema validation** is strict; `manifest.resources` is required since beta.63 and enforced by `scripts/check-extension-resources.ts`.

14. **Minor: `worker-extension-host.ts` sync filesystem writes for the worker runtime bundle** (`mkdtempSync`, `writeFileSync`, `existsSync`). Synchronous FS is the only available path for this boot-time setup; acceptable.

15. **Shutdown did not stop running worker-isolated extensions.** `index.ts` already stopped cron, webhooks, flows, DDL queue, and the HTTP server, but `WorkerExtensionHost.stopAll()` was missing.

### Fixes / experiments

- [x] **Stop extension workers during graceful shutdown** — `packages/engine/src/index.ts` now imports `getWorkerHostIfInitialized` and calls `await getWorkerHostIfInitialized()?.stopAll()` before draining the DB pool. Verified with `bun x biome check` and `bun run typecheck`.

### TODOs

- [x] Confirm extension table allowlist is fail-closed.
- [x] Confirm worker isolation host limits env and tenants.
- [ ] Read `extension-marketplace-routes.ts`, `extension-download.ts`, and `extension-license.ts` in a later pass.
- [ ] Verify WASM extension host state and whether it is wired into shutdown.

---

## Session 5 — Auth & Sessions

**Goal:** Understand Better-Auth integration, session prefetch, extension auth gate, API-key hashing, and extension-signature verification.

### Files inspected

- `packages/engine/src/lib/auth.ts`
- `packages/engine/src/middleware/session-prefetch.ts`
- `packages/engine/src/middleware/extension-auth-gate.ts`
- `packages/engine/src/lib/security/api-key-hash.ts`
- `packages/engine/src/lib/security/signature-verify.ts`
- `packages/engine/src/lib/security/registry-keys.ts`
- `packages/engine/src/lib/security/url-validator.ts`
- `packages/engine/src/lib/security/ws-origin.ts`

### Observations

1. **Better-Auth runs on its own database pool.** `initAuth` creates a dedicated `authDb` (`DB_AUTH_POOL_MAX`, default 3) so that abandoned tenant transactions carrying `SET LOCAL ROLE zveltio_rls` cannot contaminate auth lookups.

2. **Session prefetch runs before the tenant transaction.** `session-prefetch.ts` resolves the session, god flag, and user role on the engine's own pool connection, preventing the `permission denied for table session` abort that used to poison tenant transactions.

3. **Extension auth gate is fail-closed.** Every `/ext/<name>/*` route requires an authenticated session unless the extension manifest explicitly lists the sub-path in `publicRoutes`. `ZVELTIO_EXT_AUTH_GATE=0` is the operational escape hatch; production boot refuses it.

4. **Self-registration is gated at the database hook.** `databaseHooks.user.create.before` calls `isRegistrationEnabled`, so OAuth, magic link, and password sign-up all respect the same setting. `withAuthorizedUserCreation` provides an ALS escape for invitations and CLI bootstrapping.

5. **Magic link is configured with `disableSignUp: true` and `storeToken: 'hashed'`.** This closes both the open-registration bypass and the plaintext-token storage hole.

6. **Password hashing uses argon2id via `Bun.password`.** Legacy scrypt hashes are verified transparently and silently re-hashed to argon2id; `PASSWORD_LEGACY_SCRYPT_DEADLINE` can enforce a hard cut-off.

7. **Sensitive credentials are encrypted/hashed at rest.** 2FA backup codes use `storeBackupCodes: 'encrypted'`; verification identifiers and magic-link tokens are hashed.

8. **API keys are hashed with HMAC-SHA256 keyed on `BETTER_AUTH_SECRET`.** A DB compromise alone is not enough to forge keys.

9. **Extension archive signatures use Ed25519 over the bundle SHA-256.** `verifySignature` checks hash, key trust, and signature. Missing signatures fail unless `REQUIRE_EXTENSION_SIGNATURES=false` is set.

10. **`revokeAllUserSessions` clears both the database and the Valkey secondary storage.** It also supports sparing the current session token so a user hardening their own account is not logged out.

11. **Trusted origins fall back to auto-detected local interfaces when `CORS_ORIGINS` is unset.** A production warning is logged. Better-Auth's CSRF protection is pinned explicitly via `advancedCookieConfig`.

12. **No code changes required in this session.** The auth path is already well-hardened; observations are recorded for the cross-session summary.

### Fixes / experiments

- (none)

### TODOs

- [x] Confirm session prefetch order and god/role pre-fetch.
- [x] Confirm extension auth gate is fail-closed.
- [x] Confirm API-key and extension-signature integrity.
- [ ] Verify whether OAuth providers need an explicit `disableSignUp` equivalent; database hook already covers user creation.
- [ ] Review `sso-session.ts` and `keyring.ts` if SSO/encryption keyring features are exercised.

---

## Session 6 — Background Services

**Goal:** Understand webhooks, realtime bus, WebSocket delivery, cron/flow scheduling, and their shutdown behaviour.

### Files inspected

- `packages/engine/src/lib/webhooks.ts`
- `packages/engine/src/lib/webhook-worker.ts`
- `packages/engine/src/lib/runtime/realtime-bus.ts`
- `packages/engine/src/routes/ws.ts`
- `packages/engine/src/routes/realtime.ts`
- `packages/engine/src/lib/runtime/cron-runner.ts`
- `packages/engine/src/lib/flows/index.ts`
- `packages/engine/src/lib/flows/flow-scheduler.ts`
- `packages/engine/src/lib/flows/flow-executor.ts`
- `packages/engine/src/lib/flows/cron.ts`
- `packages/engine/src/lib/runtime/garbage-collector.ts`

### Observations

1. **Webhooks are signed with HMAC-SHA256.** `repairUnsignedWebhooksAtBoot` generates secrets for legacy webhooks. Delivery records are written to `zvd_webhook_deliveries`; custom headers are filtered against a blocklist.

2. **Webhook worker uses Valkey.** It polls `webhook:queue`, delivers concurrently, retries with exponential backoff (`1s → 2s → 4s`), and moves exhausted payloads to a bounded dead-letter queue (`webhook:dlq`).

3. **Realtime bus has two backends.** Valkey PUB/SUB is preferred; pg_notify LISTEN/NOTIFY is the fallback. Both suppress self-echo with a per-process `originId`, and pg_notify payloads are trimmed to stay under the 8KB cap.

4. **WebSocket routes enforce origin and auth at upgrade.** `checkWsOrigin` prevents cross-site WebSocket hijacking. Each socket captures its tenant at upgrade time; `socketMayRead` runs permission checks inside `runWithDomain(tenantId)`. Permission decisions are cached per socket.

5. **Cron runner executes extension schedules in-process.** It persists runs to `zv_extension_schedule_runs`, supports retry/backoff, and emits OTel spans. It currently has no cross-instance lock; this is documented.

6. **Flow scheduler uses `FOR UPDATE SKIP LOCKED`** to avoid double-execution across replicas. It supports cron, interval, and `ai_task` triggers, and advances `next_run_at` after each run.

7. **`query_db` flow steps are read-only.** The executor issues `SET TRANSACTION READ ONLY`, drops to `zveltio_flow_reader`, sets the tenant GUC, and applies `statement_timeout`. Dangerous SQL patterns are rejected as defence in depth, but Postgres provides the real guarantee.

8. **`run_script` steps run through `runScript` with a timeout.** `send_email` validates the recipient. `webhook` steps sanitize headers and validate URLs via `safeFetch`.

9. **Shutdown already covers the main background services.** `index.ts` calls `cronRunner.stop()`, `webhookWorker.stop()`, `flowScheduler.stop()`, and `await realtimeBus().stop()`. The extension-worker stop was added in Session 4.

10. **No code changes required in this session.** The background-service layer is already well-hardened.

### Fixes / experiments

- (none)

### TODOs

- [x] Confirm webhook signing and retry/DLQ behaviour.
- [x] Confirm realtime bus backends and self-echo suppression.
- [x] Confirm flow scheduler locking and read-only query execution.
- [ ] Review `script-runner.ts` if sandboxed JS execution is a focus area.
- [ ] Review backup/trash/garbage-collector scheduling in detail if needed.

---

## Session 7 — Storage & AI Integrations

**Goal:** Audit object storage, file serving, media upload security, and how the engine consumes AI services from extensions.

### Files inspected

- `packages/engine/src/lib/storage/index.ts`
- `packages/engine/src/lib/storage/config.ts`
- `packages/engine/src/lib/storage/driver.ts`
- `packages/engine/src/lib/storage/local-driver.ts`
- `packages/engine/src/lib/storage/s3-driver.ts`
- `packages/engine/src/lib/storage/probe.ts`
- `packages/engine/src/lib/security/url-validator.ts` (SSRF guard used by probe)
- `packages/engine/src/lib/service-registry.ts`
- `packages/engine/src/routes/storage.ts`
- `packages/engine/src/routes/files.ts`
- `packages/engine/src/lib/cloud/document-indexer.ts`
- `packages/engine/src/lib/data-quality.ts` (AI analysis path)
- `packages/engine/src/lib/flows/flow-executor.ts` (`ai_decision` step)

### Observations

1. **Storage abstraction is clean.** Two drivers (`local`, `s3`) share a single `StorageDriver` interface. `local` is the zero-dependency default; `s3` is opt-in via `S3_ENDPOINT` or DB overlay.

2. **Local driver is hardened.** Writes are atomic (`tmp` + `rename`), keys are confined with `safeLocalPath`, `.meta` sidecars persist content-type, and private files require HMAC-signed URLs (`?exp=…&sig=…`). Public namespaces are explicit (`public/`, `media/`).

3. **File serving supports Range requests.** `GET /files/*` streams from disk via `Bun.file`, handles `206 Partial Content`, and rejects `.meta`/`.tmp-*` keys.

4. **Upload route validates aggressively.** Magic-byte MIME detection overrides client `file.type`; extensions are allowlisted; SVG is sanitized server-side; size and per-tenant quota are enforced; rate limiting (`writeRateLimit`) is applied.

5. **S3 probe has SSRF guard.** `validateStorageEndpoint` blocks cloud-metadata/link-local targets while keeping private ranges open for self-hosted SeaweedFS/MinIO.

6. **AI in core is intentionally thin.** The engine exposes `serviceRegistry.get('ai.providers')` and lets the `ai` extension register the actual provider. Core AI touchpoints (`ai_decision` flow step, data-quality analysis, document indexing) all degrade gracefully when no provider is registered.

7. **Default tenant sentinel was duplicated.** `routes/storage.ts` defined its own `DEFAULT_TENANT` constant and `tenantOf()` helper, duplicating the source of truth in `tenant-manager.ts` / `route-db.ts`.

### Fixes / experiments

- **`packages/engine/src/routes/storage.ts`**: Removed the local `DEFAULT_TENANT` constant and `tenantOf()` helper; replaced all `tenantOf(c)` calls with the already-imported `tenantId(c)` from `lib/route-db.ts`. This keeps the default-tenant sentinel in one place and prevents drift.

### Verification

- `bun x biome check packages/engine/src/routes/storage.ts packages/engine/src/lib/route-db.ts packages/engine/src/lib/tenancy/tenant-manager.ts` — passed.
- `cd packages/engine && bun run typecheck` — passed.

### TODOs

- [x] Review storage driver abstraction and local/S3 security.
- [x] Review upload MIME validation, SVG sanitization, and quota checks.
- [x] Review file-serving route and signed-URL verification.
- [x] Confirm AI provider registry decoupling.
- [ ] Inspect `zveltio-extensions/ai` implementation when Session 10 reaches extensions catalog.

---

## Session 8 — Studio & SDUI

**Goal:** Audit the admin SPA's API client, auth state, HTML sanitization, extension API, and server-driven UI schema.

### Files inspected

- `packages/studio/src/lib/api.ts`
- `packages/studio/src/lib/api.test.ts`
- `packages/studio/src/lib/config.ts`
- `packages/studio/src/lib/auth.svelte.ts`
- `packages/studio/src/lib/sanitize.ts`
- `packages/studio/src/lib/utils/safe-redirect.ts`
- `packages/studio/src/lib/denial.ts`
- `packages/studio/src/lib/sdui/types.ts`
- `packages/studio/src/lib/sdui/validate.ts`
- `packages/studio/src/lib/extension-api.svelte.ts`
- `packages/studio/src/lib/load-extension-contributions.ts`
- `packages/studio/src/routes/login/+page.svelte`
- `packages/studio/src/routes/(admin)/+layout.svelte`

### Observations

1. **Studio API client centralizes all engine calls.** It reads `ENGINE_URL` from `VITE_ENGINE_URL`, `window.localStorage`, or `window.location.origin`, sends credentials, and parses the unified error envelope (`detail → title → error → message → status`).

2. **Tenant slug lives in `localStorage`.** The `x-tenant-slug` header lets an admin work in one tenant in one tab and a different tenant in another. The low-level `api.fetch()` wrapper added the header, but the typed JSON helpers (`api.get/post/put/patch/delete`) did not.

3. **Auth state uses Svelte 5 runes.** `auth.init()` fetches `/api/me` via `api.fetch`, so it carried the tenant header; most other reads/writes did not.

4. **HTML sanitization is well-layered.** `safeHtml()` uses DOMPurify with an allowlist, a style hook that drops `url(|expression(|@import`, and a strict URI regexp. `safeEmailHtml()` is a separate policy for mail. `safeIframeSrc()` and `safeCssColor()` prevent malicious URLs/styles in page-builder content.

5. **Redirect validation is strict.** `safeRedirect()` rejects scheme-relative URLs, backslashes, and paths outside the app's `base`, closing the open-redirect phishing vector on the login page.

6. **SDUI is versioned and validated.** `validateSchema()` refuses future major versions and reports structural errors instead of rendering a broken page. The schema supports list/form/detail/builder/checklist/master-detail layouts and action prompts.

7. **Extension API has reactive registries.** Routes, slots, and form-alter hooks live in `$state`; `installGlobalApi` exposes `window.__zveltio` for IIFE bundles, and `loadExtensionContributions` sync-activates compile-time contributions.

8. **Admin layout handles lifecycle cleanly.** It disconnects the realtime WebSocket on sign-out so the next user does not inherit subscriptions, and prompts for refresh after a Studio rebuild.

### Fixes / experiments

- **`packages/studio/src/lib/api.ts`**: Added `...tenantHeader()` to the JSON request helpers so every `api.get/post/put/patch/delete` call sends `x-tenant-slug` when one is selected in localStorage. Previously only the raw `api.fetch()` wrapper sent it.
- **`packages/studio/src/lib/api.test.ts`**: Added a test that stubs `localStorage` with a tenant slug and asserts the header is present on a typed `api.get()` call.

### Verification

- `bun x biome check packages/studio/src/lib/api.ts packages/studio/src/lib/api.test.ts` — passed.
- `cd packages/studio && bun run test` — 14 files, 88 tests passed.
- `cd packages/studio && bun run typecheck` — 0 errors, 0 warnings.

### TODOs

- [x] Verify API client sends credentials and tenant header on all paths.
- [x] Review HTML/iframe/CSS sanitization policies.
- [x] Review SDUI schema validation.
- [x] Review extension contribution lifecycle.
- [ ] Spot-check a few route-specific `.svelte` pages if time allows.

---

## Session 9 — SDK & CLI Public Surface

**Goal:** Audit the public SDK API and the CLI commands extension authors and operators rely on.

### Files inspected

- `packages/sdk/src/index.ts`
- `packages/sdk/src/extension/index.ts`
- `packages/sdk/src/client/ZveltioClient.ts`
- `packages/sdk/src/errors.ts`
- `packages/cli/src/index.ts`
- `packages/cli/src/commands/extension-validate.ts`
- `packages/cli/src/commands/extension-pack.ts`
- `packages/cli/src/commands/extension-publish.ts`
- `packages/cli/src/lib/pack-isolation.ts`

### Observations

1. **SDK exports are stable and versioned.** `ZveltioClient`, `ZveltioExtension`, `ZveltioApiError`, `ZveltioRealtime`, `LocalStore`, `SyncManager`, plus subpath exports for `/extension`, `/codegen`, `/validate`, `/testing`, `/publish`, `/build`, `/studio`, `/ddl`, `/rpc`, `/offline`.

2. **Extension context is capability-gated.** Extensions read their own `vars` instead of `process.env`, use tenant-scoped `ctx.db`, and must declare `db:admin` for `ctx.adminDb`. Internals (`encryptSecret`, `safeFetch`, `withTenantIsolation`, etc.) are explicitly first-party/official-extension territory.

3. **Problem envelope is canonical in `errors.ts`.** RFC 9457 `problem+json` plus `code` and `traceId`; tolerant fallback for legacy `{ error }` bodies. `ZveltioApiError` parses the full shape.

4. **CLI `extension` commands enforce v2 + integrity.** `validate` checks manifest schema, peer-deps allowlist, migrations (with DOWN for destructive changes), SDUI schema endpoint namespaces, bundle size, and the §2 isolation policy. `pack` bundles `engine/index.ts` with Bun, hashes the artifact and the source tree, and auto-injects `worker` isolation for community publishers. `publish` orchestrates validate → pack → Studio build → archive → Ed25519 sign → upload.

5. **Isolation resolution is sticky but reversible.** `resolvePackIsolation` clears a community-injected `worker` on a later first-party pack unless `--keep-isolation` is passed, preventing monorepo extensions from silently staying on worker forever.

6. **No clear defects found.** The SDK/CLI surface is already well-hardened and extensively documented.

### Fixes / experiments

- (none)

### Verification

- `cd packages/sdk && bun run typecheck` — passed.
- `cd packages/cli && bun run typecheck` — passed.

### TODOs

- [x] Review SDK public exports and extension context surface.
- [x] Review CLI validate/pack/publish pipeline.
- [x] Confirm v2 manifest + integrity enforcement.
- [ ] Consider aligning `ZveltioClient.request` with `ZveltioApiError` in a future SDK improvement (not a defect).

---

## Session 10 — zveltio-extensions Catalog

**Goal:** High-level audit of the official extension catalog, focusing on v2 manifest shape, isolation policy, authorization, SSRF posture, and migration hygiene.

### Files inspected

- `../zveltio-extensions/README.md`
- `../zveltio-extensions/REVIEW-STATUS.md`
- `../zveltio-extensions/REVIEW-CHECKLIST.md`
- `../zveltio-extensions/ai/engine/index.ts`
- `../zveltio-extensions/ai/engine/lib/ai-provider.ts`
- `../zveltio-extensions/ai/engine/lib/endpoint-guard.ts`
- `../zveltio-extensions/ai/manifest.json`
- `../zveltio-extensions/developer/graphql/engine/index.ts`
- `../zveltio-extensions/data/export/engine/index.ts`
- `../zveltio-extensions/scripts/check-extension-authorization.ts`
- `../zveltio-extensions/scripts/check-bespoke-contracts.ts`
- `../zveltio-extensions/scripts/check-bundle-sources.ts`
- `../zveltio-extensions/scripts/validate-migration-paths.ts`

### Observations

1. **Catalog is large and well-organized.** 56 official extensions across 23 categories, each with `engine/` and optional `studio/`/`client/` folders. Most admin pages are SDUI schemas; bespoke Svelte pages are tracked in `STUDIO-DEFERRED.md`.

2. **v2 manifests are pervasive.** Sampled extensions (`ai`, `developer/graphql`, `data/export`) all declare `mountStrategy: 'subapp'`, `engine.bundled: true`, and `integrity.engineSha256`.

3. **Authorization gate passes for all 49 state-changing extensions.** `scripts/check-extension-authorization.ts` verified that every extension with POST/PUT/PATCH/DELETE routes references an authorization helper (`permissionGate`, `checkPermission`, etc.).

4. **Bundle/source integrity holds.** `scripts/check-bundle-sources.ts` confirmed every packed bundle matches its source tree hash.

5. **Migration paths are valid.** `scripts/validate-migration-paths.ts` checked 55 extensions with no errors.

6. **Bespoke page/route contracts resolve.** `scripts/check-bespoke-contracts.ts` found no unresolved Studio-page calls to engine endpoints.

7. **SSRF posture is deliberate.** The `ai` extension uses `assertNonMetadataUrl` (not `assertPublicUrl`) for provider base URLs so self-hosted Ollama/local gateways keep working, while still blocking cloud-metadata endpoints. Other extensions that call fixed public provider URLs (Twilio, Vonage, ANAF, Anthropic) use plain `fetch`, which is acceptable for hardcoded third-party endpoints.

8. **AI provider key handling is correct.** `initAIProviders` decrypts stored keys, skips rows that fail decryption, and validates base URLs before constructing providers.

### Fixes / experiments

- (none)

### Verification

- `cd ../zveltio-extensions && bun scripts/check-extension-authorization.ts .` — passed (49 extensions).
- `cd ../zveltio-extensions && bun scripts/check-bespoke-contracts.ts` — passed (0 errors).
- `cd ../zveltio-extensions && bun scripts/check-bundle-sources.ts` — passed (55 extensions).
- `cd ../zveltio-extensions && bun scripts/validate-migration-paths.ts .` — passed (55 extensions).
- `cd ../zveltio-extensions && bun run typecheck` — passed.

### TODOs

- [x] Confirm all sampled extensions use v2 manifests + subapp mounting.
- [x] Confirm extension authorization gate passes.
- [x] Confirm bundle/source integrity and migration path gates pass.
- [x] Review AI extension SSRF posture and key decryption.
- [ ] Deep-dive individual extensions only when a specific risk area is identified.

---

## Overall Status

| Session | Topic | Status | Commit Range |
|---------|-------|--------|--------------|
| 1 | Engine bootstrap & request lifecycle | Completed (1 fix applied) | unstaged |
| 2 | Tenancy, RLS & security | Completed (2 fixes applied) | unstaged |
| 3 | Data layer (collections, DDL, ghost DDL, write pipeline) | Completed (1 fix applied) | unstaged |
| 4 | Extensions & sandbox | Completed (1 fix applied) | unstaged |
| 5 | Auth & sessions | Completed (no fixes) | — |
| 6 | Background services (flows, webhooks, realtime, cron) | Completed (no fixes) | — |
| 7 | Storage & AI integrations | Completed (1 fix applied) | unstaged |
| 8 | Studio & SDUI | Completed (1 fix applied) | unstaged |
| 9 | SDK & CLI public surface | Completed (no fixes) | — |
| 10 | zveltio-extensions catalog | Completed (no fixes) | — |

---

## Security Blocker Audit — Post-Session Line-by-Line Pass

After completing Sessions 1-10, a second pass focused on the known functional blockers surfaced before stable release. Three clear defects were fixed; the rest remain queued.

### Files inspected

- `packages/engine/src/routes/insights.ts`
- `packages/engine/src/lib/tenancy/column-permissions.ts`
- `packages/engine/src/lib/tenancy/tenant-manager.ts`

### Fixes / experiments

- **`packages/engine/src/routes/insights.ts`**: Scoped `POST /dashboards/:id/shares` dashboard lookup by `tenant_id`. The previous query only filtered the share row by tenant, so a share payload aimed at a dashboard in tenant A could match a dashboard with the same id owned by the current user in tenant B. Replaced the local `tenantOf()` helper with the existing `tenantId(c)` from `lib/route-db.ts` for consistency.
- **`packages/engine/src/lib/tenancy/column-permissions.ts`**: `filterWritableFields` now treats `hidden` columns as not writable. Previously a field marked only `hidden` (read concealment) was still accepted on create/update because the write filter only checked `readOnly`. Added unit tests covering hidden, read-only, wildcard, and mixed access shapes.
- **`packages/engine/src/lib/tenancy/tenant-manager.ts`**: Replaced identifier string interpolation with `sql.id()` in `applyTenantRLS`, `reconcileExtensionTenantRLS`, and `reconcileExtensionTenantPolicies`. The `CREATE POLICY tenant_isolation` statement and related DDL now use Kysely identifier parameters instead of concatenating table/policy names. The visible-set function expression is still emitted via `sql.raw()` because it is a SQL expression fragment, not an identifier, and is read from the catalogue rather than user input.

### Verification

- `bun x biome check packages/engine/src/routes/insights.ts packages/engine/src/lib/tenancy/column-permissions.ts packages/engine/src/lib/tenancy/tenant-manager.ts packages/engine/src/lib/tenancy/resource-grants.ts packages/engine/src/tests/unit/column-permissions.test.ts packages/engine/src/tests/harness/data-timetravel-column-access.test.ts packages/engine/src/tests/harness/data-expand-column-access.test.ts` — passed.
- `cd packages/engine && bun run test:unit` — 2642 pass, 0 fail (2657 tests, 15 skip).
- `cd packages/engine && TEST_DATABASE_URL=postgresql://postgres@localhost:5433/zveltio_test ZVELTIO_REGISTRATION_ENABLED=1 FIELD_ENCRYPTION_KEY=... bun run test:harness` — 1058 pass, 0 fail (1064 tests, 6 skip) on a fresh Postgres cluster on port 5433.
- `bun run typecheck` — 7 packages successful.

### Additional fixes discovered during harness verification

- **`packages/engine/src/lib/tenancy/resource-grants.ts`**: Session 2 replaced `node:fs` with `Bun.file`, but `Bun.file(path).exists()` returns `false` for directories. `resourcesDeclaredOnDisk` therefore short-circuited and returned `[]` whenever `EXTENSIONS_DIR` pointed at a real directory. Replaced the directory-existence check with `Bun.file(base).stat()` + `isDirectory()`.
- **`packages/engine/src/tests/harness/data-timetravel-column-access.test.ts`** and **`packages/engine/src/tests/harness/data-expand-column-access.test.ts`**: These tests created rows with a hidden-but-writable column. After closing the known gap (hidden = not writable), that create is correctly refused. Updated both tests to create the visible fields through the API and seed the hidden value directly as the DB owner, preserving the original intent (hidden columns are stripped from reads/expand/time-travel).

### Active blockers

- None. The previous migration-divergence failure was environmental; verification is now clean on a freshly initialized Postgres cluster on port 5433.

### Remaining queue

- `forms` file-upload route review.
- `crm` pipeline route tenant/ownership checks.
- `hr/time-tracking` invoice numbering race.
- `auth/scim` Groups CRUD edge cases.
- `projects/helpdesk` field name mismatch.

---

## Cross-Session TODOs

- [ ] Revisit known gaps in `docs/platform/known-gaps.md` and verify each against source.
- [ ] Verify boundary audit findings in `docs/private/ZVELTIO-VS-SUPABASE-AND-BOUNDARY-AUDIT.md`.
