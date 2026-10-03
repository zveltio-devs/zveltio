# Engine review brief (cloud, fresh eyes)

Written for a reviewer who has this repository and nothing else: no private
notes, no previous review ledgers. Everything you need is here, in `AGENTS.md`,
and in the code. Read `AGENTS.md` first.

## What Zveltio's engine is, and the one rule

`packages/engine` is a pure BaaS (the same job as Supabase, PocketBase or
Directus): collections, auth, permissions, RLS, realtime, storage, flows.
Everything business-shaped is an extension (`../zveltio-extensions`, a separate
repository). The rule the engine is held to: **correct and flexible first;
extensions adapt to the engine, never the reverse.** A finding is not
"acceptable because an extension relies on it". If an extension needs
something the engine refuses, the right fix is an official, capability-gated
path in the engine, not a hole.

## What we want from you

Find what is still wrong. Prior reviews were file by file and still missed
holes that a cross-cutting read found later, so read across layers: follow one
request from the HTTP route through auth, the tenant transaction, the
permission check, the SQL, and back.

For every finding give: severity, `file:line`, a concrete failure scenario
(input or state and the wrong outcome), and how you proved it (a failing test,
a query, a trace). "Looks risky" without a scenario is not a finding. We trust
a broken fixture run the way CI runs it over a reading of the code: reading
alone has been wrong here many times.

Also report optimisations that are measurable (a query plan, a benchmark), not
stylistic ones.

## Where to look, in priority order

1. **Tenancy.** Every tenant-scoped table carries `tenant_id` under RLS
   (`lib/tenancy/`, `applyTenantRLS`). Look for any path that reads or writes
   tenant data on the bare pool instead of the tenant transaction, any code
   that trusts a tenant id from the client, cross-tenant leaks in error
   messages, audit rows, realtime fan-out, search, sync, exports, background
   jobs and caches (Valkey keys).
2. **RLS and row rules.** Row-rule policies, the `user_email` / `user_id`
   rule variables, permissive policies OR-ing together (splitting a rule into
   several permissive policies widens access), `?as_of=` and other read paths
   that might skip the read gate (`readScope`), hidden columns used as
   filter/sort/search oracles.
3. **Auth.** better-auth integration, sessions, API keys (a key's identity is
   its creator; a key whose creator is gone must stop working), SSO/SCIM
   provisioning through `ctx.internals` (`identity:provision`), invitations
   (tokens stored as digests), rate limits, case handling of emails.
4. **Database roles.** The narrow roles and what each may reach:
   `zveltio_rls` (tenant requests), `zveltio_ext` / `zveltio_ext_bypass` and
   the per-extension roles (inline extension `ctx.db`), `zveltio_worker`
   (worker-isolated extensions), `zveltio_flow_reader`. Code:
   `lib/extensions/ext-db-role.ts`, `lib/tenancy/temp-privilege.ts`,
   migration 001. Questions worth asking: can a role window leak its role to
   the next statement on a pooled connection; can a restricted role leave an
   object (temp table, function) that the engine role later executes; does a
   disabled or uninstalled extension keep any grant; can one extension reach
   another's tables at the database layer.
5. **The extension SQL analyzer.** `lib/extensions/worker-sql-policy.ts` and
   the ctx.db wrapper: every statement's compiled SQL is checked (builder and
   raw), one statement of an allowed kind, a table allowlist, a function
   denylist, and a lexer that must agree with Postgres (dollar quotes,
   comments, unicode escapes, `E''` strings). Try to get a statement past it
   that touches an engine table (`"user"`, `zv_api_keys`, `zvd_permissions`)
   or runs DDL. Remember the role underneath is the second layer: a bypass of
   the analyzer that the role still refuses is a medium, not a critical.
6. **Migrations.** `packages/engine/src/db/migrations/sql/`. Every migration
   must be re-runnable, carry a `-- DOWN` section, and never be rewritten once
   released (the upgrade-path gate hashes released files). Look for a
   migration that is not idempotent, takes a lock that blocks writes on a big
   table, or leaves a DOWN that does not invert the UP.
7. **Performance.** RLS predicate shape and index use (`EXPLAIN ANALYZE` on a
   seeded tenant), per-statement round trips added by the role windows (two
   per ctx.db statement inside a transaction, a short transaction per
   statement on the pool), N+1 in list/expand paths, pool sizing and
   advisory-lock usage (`db/advisory-lock.ts`; `db.connection()` does not pin
   a backend).

## Already closed (do not re-report unless you can show it is still broken)

Each item is a merged PR; `git log --grep '#NNN'` shows the change and its
test.

- Tenant isolation: audit log carries `tenant_id` under RLS and rows land on
  the tenant they concern (#865, #873); m2m junction tables under RLS (#867);
  no per-tenant or per-environment schemas (#866, #872); extensions enter only
  their own tenant unless they hold `db:admin` (#849, #856).
- RLS: row-rule policies read the caller's setting once per statement (#855);
  one role vocabulary for reads and writes (`principalRole`, #868); row-rule
  reads use the rule column's index (#869).
- Auth: invitation tokens stored as digests (#854); API keys of a deleted
  creator stop authenticating (#862); atomic identity provisioning (#863,
  #877); email unique case-insensitively (#880).
- Storage: S3 objects private by default, public URL only under `public/` and
  `media/` (#864).
- Database roles: narrow roles reach collections only (#853); `ctx.db` runs
  as `zveltio_ext` in the tenant transaction (#874), on the pool and in
  `adminDb` (#878); worker extensions reach their own tables (#876); an
  extension's prefix no longer reaches engine tables (#875); ghost-DDL
  changelog trigger runs as owner and definer functions pin `pg_temp` last
  (#879); restricted roles cannot create temporary objects (#881).
- Extension SQL analyzer: table allowlist for raw SQL (#858); every
  statement's compiled SQL is checked (#870); one DML statement, DDL and
  sandbox-escape functions refused (#871).
- Migrations apply by set under one lock on every runner path (#882).

The closing PRs of this brief's own session are listed in the section below.

## Closed in the session that wrote this brief

- #883 — where boot cannot revoke TEMPORARY (the engine does not own the
  database), the extension role windows run `DISCARD TEMP` after each
  extension statement, so a temp table cannot shadow an engine table for the
  engine's next statement.
- #884 — accounts stored with a mixed-case email are found by every lookup
  (better-auth adapter, tenant create/members, god recovery). Stored emails
  are deliberately not rewritten: `user_email` row rules compare exactly
  against row values written with the stored spelling.
- #885 — each extension runs as its own database role (inline, BYPASSRLS twin,
  worker); owned prefixes resolve to the longest matching extension; disable
  revokes, uninstall drops. Installs where the engine cannot create roles
  (`scripts/bootstrap-db-role.sh`) keep one shared role — worth checking.
- #886 — `ctx.DDLManager` mutations run on the engine pool and commit before
  returning; a collection an extension creates gets tenant RLS and grants at
  once. Known edges: schema changes survive a request rollback; deferred
  CONCURRENTLY index builds go to the DDL queue (`ddl.build_index`) before
  the request goes on, so a rollback or crash does not lose them.

Open on purpose, worth a second opinion: hardened installs without
per-extension roles; two replicas granting
the same table at first boot can race ("tuple concurrently updated").

## How to run things

Prereqs: Bun ≥ 1.3.13, PostgreSQL 16+ (CI uses 18) with `pg_trgm` and
`vector`, optional Valkey 8. From the repo root:

```sh
bun install
# Harness and integration tests need a real database:
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/zveltio_test
export DATABASE_URL=$TEST_DATABASE_URL
# Harness files that sign up a user need this, as CI sets it:
export ZVELTIO_REGISTRATION_ENABLED=1

cd packages/engine
bun run test:unit           # src/tests/unit
bun run test:harness        # boots engines against Postgres
bun run test:integration    # out-of-process engine on :3099, see AGENTS.md
bun run typecheck
```

Quality gates: `bun run prepush` runs fifteen of them; CI's `Lint` job runs
more (`.github/workflows/ci.yml`, every `run: bun run …` step there).
`bun run format:check` is Biome and must print "No fixes applied".
`bun run audit:gates` plants a violation into each gate and expects 47/47 —
it needs `DATABASE_URL` pointing at a migrated scratch database, otherwise
three cases report "FAILED FOR THE WRONG REASON".

Several gates read the sibling extensions checkout at `../zveltio-extensions`
through a hardcoded path; clone it next to this repository or those gates
measure nothing.

Traps that cost previous sessions a CI round:

- Never symlink `node_modules` into a worktree; the worker-source hash changes
  and the Type Check job fails.
- Process-wide role state in the harness: a test that builds
  `createRestrictedDb` without the grants `load.ts` gives must switch the
  extension role off first.
- On Postgres 16+, check role membership with `pg_has_role(…, 'SET')`, not
  `MEMBER`: a CREATEROLE engine holds the roles it created WITH ADMIN but SET
  FALSE.
- One DDL-queue test group times out at 30 s on some CI runs; a rerun passes.
  Perf Smoke `delete.p95` has flaked once; rerun before suspecting a change.

## What to hand back

A list of findings as described above, most severe first, and for each one
whether you fixed it (with the test that was red before) or left it open and
why.
