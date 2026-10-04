# Blind audit report — 2026-10-04

An independent review of `zveltio` (engine, Studio) and `zveltio-extensions`, run
from the two repositories alone, following [`CLOUD-REVIEW-BRIEF.md`](CLOUD-REVIEW-BRIEF.md).
Every finding below was reproduced by running code. A fix ships with a test that
failed before it and passes after it. A finding left open says why.

## Summary

- **Six findings fixed, in six PRs**: zveltio#900–#904 and
  zveltio-extensions#181.
  - Two are authorization or correctness defects in tenant-data paths:
    - record comments ignored the row gate;
    - offline sync asked for a permission name nobody can grant.
  - One is a broken first-party extension (`geospatial/postgis`).
  - One is a measured performance fix: an idle sync pull went from 60 ms to 0.1 ms at
    200 000 rows.
  - One is keyboard and screen-reader behaviour of the Studio's record and field
    drawers.
  - One is a Studio build that succeeded with zero messages.
- **One cross-repository regression left open for the owner.** It is the most
  important item here. Since engine #858, about ten first-party extensions are
  refused at runtime on their main routes (SCIM, SAML, LDAP, GDPR, storage/cloud,
  analytics, byod, migrators, graphql). The extensions' CI has not run against an
  engine that includes #858, so nothing has shown it.
- No cross-tenant leak was found in the paths read. Those paths are listed under
  "What was looked at".

## Environment and baseline

The database was PostgreSQL 18.6 + pgvector (`pgvector/pgvector:pg18`, the CI image),
with Valkey 8. Bun is 1.3.14. Each lane was run the way CI runs it.

| Lane | Result on `master` | Failures caused by the audit container, not the code |
|---|---|---|
| engine unit (`test:unit`, CI env) | 2833 pass / 3 fail | 3 × `safe-fetch-pinning`: the container sets `HTTPS_PROXY`, under which pinning deliberately steps aside. They pass with the proxy unset. |
| engine harness (`test:harness`, CI env) | 1917 pass / 10 fail | 8 × `ws-schema-events`: a test I ran at the same time created collections, which are schema events. They pass alone. 2 × `storage-local-driver`: the container runs as root, which ignores the `0o555` directory the test relies on. |
| engine typecheck | clean | — |
| Studio (`vitest`) | 52 files / 213 tests pass | Passes only after compiling messages with the inlang plugin from npm (see S-2). |
| extensions suite (CI recipe, fresh DB) | 896 pass / 60 fail | 8 × mail (no IMAP server). The other 52 are finding X-1. |
| engine integration, e2e | not run locally | They ran in CI on every PR below; all green on zveltio#900. |

## Findings

| # | Severity | Where | Status |
|---|---|---|---|
| X-1 | **high** (functional, cross-repo) | engine `lib/extensions/worker-sql-policy.ts` (#858) vs ~10 extensions | **open — owner decision** |
| E-1 | medium (authorization) | `routes/revisions.ts:170`, `:195` | fixed — zveltio#900 |
| E-2 | medium (correctness) | `routes/sync.ts:268`, `:631` | fixed — zveltio#901 |
| X-2 | high (functional) | `zveltio-extensions/geospatial/postgis/engine/routes.ts:28` | fixed — zveltio-extensions#181 |
| P-1 | medium (performance) | `routes/sync.ts` pull query; `tenant-manager.applyTenantRLS` | fixed — zveltio#903 |
| S-1 | medium (accessibility) | `studio/.../RecordDrawer.svelte`, `AddFieldDrawer.svelte` | fixed — zveltio#902 |
| S-2 | low (build robustness) | Studio `i18n:compile` | fixed — zveltio#904 |
| D-1 | to be assessed (design) | Electric sync | open — owner decision, detail sent privately |
| X-3 | info | extensions CI `Typecheck` job, red on master | open |

### X-1 — first-party extensions refused by the `ctx.db` allowlist since #858 (open)

**Scenario.** On engine `master` with extensions `master`, several first-party
extensions fail on their main routes, either with 500 or with a silent refusal:

- `auth/scim` provisioning (`PUT /Users/:id` → 500);
- `auth/saml` and `auth/ldap` sign-in;
- `compliance/gdpr` (`/export-my-data`, `/delete-my-account`);
- `storage/cloud` (`/trash`);
- `analytics/dashboard`;
- `developer/byod` (`/stats`);
- `integrations/migrators` (run);
- the `developer/graphql` gate tests;
- `geospatial/postgis` (X-2).

Each refusal is `ExtensionSecurityError: … attempted to access <user | zv_tenants |
zvd_collections | information_schema.*> through ctx.db`.

**Proof.**
- The extension contract suite was run with CI's recipe: a fresh database migrated
  by the engine harness boot, the same environment, `bun test --timeout 20000`. 52 of
  its 60 failures have this cause.
- I bisected `auth/scim/engine/put-users.test.ts` with a fresh database per step:
  - good at engine `dbccc1f`, the engine the extensions' last green CI run cloned
    (2026-10-02 16:15Z);
  - first bad at **`e864df2` — #858, "raw SQL from inline extensions meets the
    table allowlist"**.
- The extensions repository's CI runs on pushes to that repository only, so it has
  not run since #858 landed.

**Why it is open.** #858 is correct. An extension reading `"user"` or the catalogue
through `ctx.db` is exactly what the allowlist exists to stop, and the brief rules
out loosening the engine for an extension. Each extension has to move to an
official, capability-gated path, the way X-2 moved to `ctx.DDLManager`. That is
roughly ten separate repacks, and SCIM, SAML and LDAP need `ctx.internals` identity
paths that I did not audit.

**Recommendations.**
1. Add a job that runs the extensions' contract suite against the engine at the PR's
   head, either in engine CI with the paired branch, or nightly in the extensions
   repository against engine `master`. Either would have caught this the day #858
   merged.
2. Fix the extensions one PR each, starting with auth/scim, auth/saml and auth/ldap
   (sign-in and provisioning).
3. Until then, treat engine releases after beta.76 as breaking those extensions.

### E-1 — record comments ignored the record's read gate (fixed, zveltio#900)

**What was broken.**
- `GET /api/revisions/record/:collection/:recordId/comments` checked collection-level
  `read` only. A member whose row policy hides a record could read every comment on
  it by naming its id.
- `POST …/comments` checked nothing. Any signed-in user could comment on any
  collection's record, including one they cannot read and one that does not exist.

Both stayed inside the tenant.

**Fix.** Both routes now pass the same gate as `GET /api/data/:c/:id`: a new shared
`recordReadable` next to `readScope`.

**Test.** `revisions-comments-rls.test.ts` failed 4 of 5 before the fix and passes 5
of 5 after. The integration test that asserted the bug now asserts the refusal.

### E-2 — offline sync asked for `data:<collection>` (fixed, zveltio#901)

**What was broken.** Push and pull checked `checkPermission(user, 'data:<c>', …)`, but
no grant can satisfy that:
- migration 001 stripped the `data:` prefix from every policy;
- the Studio permission matrix writes bare names;
- the Casbin matcher compares names exactly.

Only god and `*`/`*` could sync. A member with read and write through `/api/data`
had every push refused and every pull come back empty.

**Fix.** Sync now asks `checkAccess` with the bare name.

**Test.** `sync-permission-name.test.ts` failed 2 of 4 before and passes 4 of 4
after. Three sync tests had granted the legacy spelling, one of them both spellings,
and now grant the bare name.

### X-2 — `geospatial/postgis` collection routes answered 403 to everyone (fixed, zveltio-extensions#181)

**What was broken.** `resolveCollection` read `information_schema.tables` through
`ctx.db`, which X-1's allowlist refuses. The catch treated the refusal as "no such
table", so every collection route answered 403, god included. Behind that sat the
same `data:` permission name as E-2.

**Fix.**
- Existence is now checked through `ctx.DDLManager.getCollection`, which the engine
  runs as itself.
- The permission check uses the bare name.
- The extension harness's `checkPermission` stub now matches grants by exact name;
  it used to answer `admin` for every name.
- Version 1.0.8, repacked.

**Test.** The new `authz.test.ts` cases failed 2 of 10 before (admin and granted user
both got 403) and pass 10 of 10 after. The extension suite's failure set is
unchanged.

**Follow-up after it merges.** `docs/platform/security-model.md:392` still describes
the `data:${shortName}` check.

### P-1 — an idle sync pull read every row the tenant has (fixed, zveltio#903)

**What was broken.** The pull's cursor is a row comparison on an expression
(`extract(epoch from updated_at)…`) under the `tenant_id = ANY(…)` policy, and no
collection had an index on `updated_at`. Nothing could bound the scan, so a pull
where nothing changed read the tenant's whole collection, per collection, per
device, per poll.

**Measured.** PG 18.6, as `zveltio_rls` with FORCE RLS, on a collection created
through `POST /api/collections`, 3 runs each. The table below is from zveltio#903's
runs on a 204 000-row table. My own independent runs on a separate seed agree:
70–84 ms before, and 0.10–0.17 ms with the index and the rewrite.

| Query | 200 000-row tenant | 4 000-row tenant |
|---|---|---|
| master | 59–67 ms, 2 535 buffers | 18–21 ms |
| master + index (index unused) | 55–60 ms | 18–22 ms |
| rewritten, no index | 11–15 ms | 0.4–0.6 ms |
| **rewritten + `(tenant_id, updated_at, id::text COLLATE "C")`** | **0.05–0.11 ms, 3 buffers** | **0.06 ms** |

**Fix.** The pull adds `tenant_id =` (the `dynamicSelect` rule) and a sargable
`updated_at >=` bound beside the row comparison. `applyTenantRLS` creates the index
next to the `(tenant_id, created_at DESC)` composite, which covers new collections,
boot reconciliation and ghost DDL.

**Test.** `sync-pull-index.test.ts` asserts through `pg_stat_user_indexes` that the
real route's pull uses the index and touches fewer than 10 tuples. It failed 2 of 3
before and passes 3 of 3 after. The fix was written by a delegated agent and its
diff was reviewed here.

**Owner decision.** See decision 3 below.

**Checked and not a finding.**
- `/api/data` lists already add `tenant_id =` (`db/dynamic.ts`) and use the
  composite: 0.3 ms at 200 000 rows, and still fast for a 10-row tenant.
- `count(*)` is an index-only scan.

### S-1 — Studio drawers declared `aria-modal` but did not behave as modals (fixed, zveltio#902)

**What was broken.**
- `RecordDrawer` (create/edit on every collection page):
  - Escape was bound to a backdrop that never takes focus, so it did nothing;
  - focus stayed behind the drawer, and Tab walked into the table;
  - closing lost focus;
  - it was announced as "New record" while editing;
  - the heading and Yes/No were hardcoded English, and the colour input had no name.
- `AddFieldDrawer` had no Escape at all and no accessible name.

**Fix.** A shared `modalFocus` action handles focus in, the Tab trap, Escape and
focus return, and both drawers are named through existing i18n keys.

**Test.** 8 tests failed before and 14 of 14 pass after. The Studio lane went from
213 to 222 tests, svelte-check reports 0 warnings, and no locale file changed.

### S-2 — a Studio build with no messages succeeded (fixed, zveltio#904)

**What was broken.** `project.inlang/settings.json` loads the message-format plugin
from `cdn.jsdelivr.net`. When that host is unreachable (the audit container's egress
policy blocks it), `paraglide-js compile` prints a warning, then *"Successfully
compiled"*, and emits a 95-byte message index with **zero messages**. Every `m[…]()`
call then throws: 74 Studio tests failed, and a production build would ship a
Studio that crashes on its first string.

**Fix.** `i18n:compile` now runs `scripts/check-paraglide-output.ts` after the
compile. It fails the step when the compiled module is missing a key from
`messages/core/en.json`. The rule lives in a pure function with a unit test.

**Proof.** With the CDN unreachable, the real `i18n:compile` exited 0 before the fix
and exits 1 after it (`compiled 0 of 1540 core messages`).

**Not done.** Making the build independent of the CDN, by vendoring the plugin, is
the owner's call.

### Checked and not a finding

- `routes/(admin)/collections/erd/+page.svelte:850` swallows the error of a layout
  save. That is the `onDestroy` flush on navigation: fire-and-forget by design, with
  localStorage as the fallback and an `erd.localOnly` indicator. Its comment says so.
- Insights panels. A panel resolves only through a dashboard in the request's
  tenant. Its SQL runs as `zveltio_rls` without the viewer's identity, so one cached
  result per panel is the same for every viewer allowed to see it.
- `/api/rpc/:fn` runs in the caller's tenant transaction.
- Root-tenant API keys are minted only behind `requireInstanceAdmin`.

### D-1 — Electric sync (open)

A design question about Electric offline sync in multi-tenant installs. It was not
reproduced here, because Electric could not run in the audit container. The detail
goes to the owner privately rather than in this public document.

### X-3 — extensions CI `Typecheck` red on master (open, info)

`tsc` fails on two errors in the engine sibling's types:
- `bun:sqlite` in `@better-auth/core`;
- `SecondaryStorage` not exported by `better-auth` (`lib/runtime/cache.ts:3`).

The error is identical on master and on every branch, and it skips every later step
of that job: ambient authority, migration paths, bundle checks and SDUI validation.

## What was looked at, and what was not

**Read and exercised:**
- the read gate (`readScope`) and every read path that does not use it: revisions,
  comments, insights panels and saved queries, rpc, electric, relations, sync;
- API key authentication and both key-minting routes;
- the Casbin model and permission-name vocabulary;
- the sync push and pull write and read gates;
- RLS predicate shape and index use on seeded data;
- the Studio drawers and modal components, and the Studio i18n pipeline;
- the extensions' runtime against the current engine.

**Not audited in this session:**
- **The extension SQL analyzer** (`worker-sql-policy.ts`). The adversarial pass on
  it was stopped by the session's tooling and not resumed. Treat it as unreviewed
  here, not as cleared.
- SSO and SCIM identity provisioning through `ctx.internals`.
- The narrow database roles and role windows, in depth.
- Migration-by-migration review.
- The client portal (`packages/client`).

## Decisions for the owner

1. **X-1: how to bring the broken extensions back.**
   *Recommendation:* keep #858 as it is. Fix the extensions one PR each, starting
   with SCIM, SAML and LDAP. Add an extension-contract job against engine HEAD
   before the next engine release.
2. **E-1: what permission writing a comment needs.**
   *Recommendation:* `read` (you can comment on what you can see), which is what
   #900 does. If comments are edits in your product, change one line to `update`.
3. **P-1: the first index build on existing large tables.** It is a plain
   `CREATE INDEX` at boot inside `applyTenantRLS`, the same path the
   `(tenant_id, created_at DESC)` composite already uses. It runs before the server
   listens, once, at about 0.6 µs per row.
   *Recommendation:* accept it for beta. Move both composites to the
   post-listen `CONCURRENTLY` shape (`reconcileUniqueKeys`) before 3.0.0.
4. **D-1: Electric sync in multi-tenant installs.** The detail is with the owner,
   sent privately.
