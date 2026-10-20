# RFC: extension model v3

Status: **accepted** (owner, 2026-10-17). The decisions are recorded under
[Decisions](#decisions). All five engine phases (A–E) land before rc.1.

This RFC replaces the *goal* of [rfc-extension-runner.md](rfc-extension-runner.md),
"third-party code gets the same `ctx` as first-party code, over a SQL bridge". It
keeps that RFC's working parts: the per-extension database role, the process
runner and the request transaction.

Every number below was measured on 2026-10-17. The setup was Bun 1.3.14 and
PostgreSQL 18, on a 4-core machine. The scripts lived in a session scratchpad.
[Measurements](#measurements) says how to rerun them.

## Why change again

The extension mechanism has changed three times: an in-thread worker, then a
process, then the systemd/container runner. Each change kept one assumption and
paid for it.

**The assumption:** an untrusted extension should see the same `ctx` as a
first-party one, including raw SQL. That one goal has cost:
- 4,400 lines of bridge code (`worker-extension-host.ts` 1,929,
  `worker-sql-policy.ts` 558, runtime, protocol, transport and ctx);
- 87 of the 604 engine commits since 2026-09-01, many of them parity fixes;
- a SQL text parser on the security path.

It has also left the protection pointing the wrong way:
- **Third-party extensions in production today: 0.**
- **Community tier:** has the runner as its boundary.
- **Verified tier** (a third-party publisher we know): runs inline, with no
  boundary at all (`lib/extensions/load-phases.ts:347`).

Two more problems are not about the runner at all:
- **First-party extensions hand-write their data layer.** CRM writes
  `zvd_contacts` with raw SQL (`zveltio-extensions/crm/engine/routes.ts:234`),
  beside `/api/data/contacts`. Data flows fire only on the data API path
  (`lib/flows/data-triggers.ts`), so on the CRM path they are skipped silently.
  Half of the extension repository's commits (348 of 700) are fixes.
- **Raw SQL cannot be made safe by the database alone.** Measured under the
  extension's own role, with tenant RLS in force:
  - `SELECT set_config('<tenant guc>', '<other tenant>', true)` read another
    tenant's rows;
  - `RESET ROLE` then read password hashes.

  Today's runner survives this only because its text parser refused all 32
  attack variants we tried. A structured API makes the parser unnecessary.

## The model

### One contract, many backends

An extension is written once against **`extension-api v1`**. *Where* it runs is
decided by its trust level and the operator's profile, not by the extension.
Moving an extension between backends is configuration, never a rewrite.

| Piece | What it is |
|---|---|
| **Collections** | the extension's data, declared through schema-as-code (`lib/schema-artifact`). Permissions, RLS, column rules, audit, revisions and flows come from the engine, through the same path as `/api/data`. |
| **Actions** | synchronous business logic ("issue invoice", "convert lead"). Declared in the manifest with a typed input, a permission and the collections they read and write. They run inside the request transaction and do no network I/O. |
| **Jobs** | asynchronous work: network, mail, ANAF, AI, heavy compute. An action or a flow enqueues a job in a transactional **outbox**. The job runs out of the request, holds no transaction, and writes back only through the public API with a key scoped to the extension. |
| **Rules** | declarative expressions for validation, state transitions and flow conditions. No code and no runtime. |
| **UI** | Studio pages, as today. |
| **`host`** | the only way an action or job reaches the engine: `host.collections.read/insert/update/delete` with declarative filters, `host.enqueue`, `host.audit`, `host.config`, and `host.services` (the broker). The engine generates every SQL statement. **No raw SQL and no `ctx.internals` for anything but first-party code.** |

### Trust ladder

| Level | Who | Actions run | Jobs run |
|---|---|---|---|
| 0 First-party | Zveltio | inline | inline or job runner |
| 1 Certified | a third party, reviewed and signed by Zveltio **per version** | inline | job runner |
| 2 Published | a third party on the registry, automated checks only | isolated backend | job runner |
| 3 Private | an organisation's own extension, signed with a key the operator trusts | isolated backend (inline only if the operator opts in) | job runner |

An inline extension still reaches data only through `host.collections` with its
declared capabilities. Inline removes the memory boundary, never the data
boundary. A review that misses something does not hand out the whole database.

Certification is per version, because the 2025 npm worms arrived through
updates to trusted packages.

### Backends

The backends were chosen from measurements. The reference action is "issue
invoice": zod + decimal.js + date-fns, one read and one write, in a transaction.
All runs were warm, with Postgres CPU excluded.

| Backend | CPU / action | 2000-line compute | Memory | Isolation |
|---|---|---|---|---|
| inline | 0.163 ms | 1.8 ms | 0 | none |
| **process per extension** (Bun child, IPC) | 0.406 ms | 2.0 ms | ~60 MB | OS: uid, cgroup, egress |
| SES compartment in a Worker | 0.284 ms | 18.3 ms | 0.28 MB | language-level; no memory cap |
| QuickJS-WASM | 0.790 ms | 57 ms | 0.65 MB | precise CPU and memory limits |

- **Actions at levels 2 and 3 run in the process backend:** full JIT speed and a
  boundary that enterprise auditors recognise. Its cost is memory per active
  extension, which matters only at a scale we do not have.
- SES and QuickJS stay candidates for a later *density* backend.
- **Jobs run in Deno, one subprocess per job.** The permissions come from the
  approved manifest: `--allow-net=<approved hosts>` and nothing else, plus
  `--v8-flags=--max-old-space-size=<n>`.
  - Every escape we tried was refused: other hosts and ports, the filesystem,
    env, spawn, FFI, and asking for more permissions.
  - Cost: 31 ms to start and 60 MB while running.
  - It needs no systemd and no `CAP_SETUID`, so it runs on any PaaS.

**Rejected, with the measured reason:**

| Option | Reason |
|---|---|
| StarlingMonkey (ComponentizeJS + jco/JSPI) | 5–12 MB per instance, 12–30 MB packages, no in-thread interrupt, a trap kills the instance |
| pljs in PostgreSQL | segfaulted on the first call, and the postmaster restarted the whole cluster |
| plain Bun Worker | reads files, spawns processes as the engine uid |
| Bun Worker memory caps | `resourceLimits` and `smol` are ignored |
| Node 24 `--permission` | the job could reach any host and read env vars |
| Supabase Edge Runtime | no per-domain egress |
| workerd (open source) | no CPU or memory limits: one loop froze every worker, and one OOM killed the process |
| SES in the engine's realm | `lockdown()` strips `Error.isError`, which Bun.SQL internals use |

### Rules language

Validation already evaluates expressions with expr-eval-fork
(`lib/validation-engine.ts`). That evaluator is untyped, has no decimal type and
depends on a fork. The flow `condition` step is not implemented
(`lib/flows/flow-executor.ts:533`).

Stored rules are a compatibility surface, so the language must be chosen
**before rc.1**. The proposal is CEL: typed, non-Turing-complete, with a cost
estimate built in. It would be used for validation, transitions and flow
conditions alike.

**Phase C, first slice (landed):** validation expression rules (`custom`,
`nlp`) are CEL, run by `@bufbuild/cel` (pinned exact). `value` is bound by the
field's declared type: `integer`/`int`/`bigint`/`smallint` as CEL `int`, every
other number as `double` — CEL does not mix the two, so a rule on a decimal
field writes `value * 2.0`. `matches()` runs on RE2 (`@bufbuild/re2`), which is
linear-time. The library has no cost estimate and exports no type checker, so
the engine bounds a rule instead: at most 1,024 characters and 32 levels of
nesting, only `value` (and macro variables inside their macro) in scope, only
functions CEL defines. Migration 087 rewrites stored `and` / `or` to `&&` /
`||` where that is certain; any rule it leaves that is not CEL is refused at
evaluation, so the writes touching that field are refused and the log names the
rule.

**Second slice (landed):** the flow `condition` step runs (migration 088 admits
the type). Its `expression` is CEL over `trigger` (the run's trigger data) and
`output` (the previous step's output), with the same bounds and deadline, and is
checked when the step is saved. `true` skips the steps listed in
`false_branch`, `false` those in `true_branch`; with neither list given, `false`
ends the run, recorded as a success. An expression that does not evaluate to a
boolean, or a branch naming a step that is not after the condition, fails the
run whatever the step's `on_error` says.

**Third slice (landed):** `transition` validation rules. The CEL expression
sees `value` and `previous` (the stored value, `null` on create), with the same
bounds and deadline. Create, PATCH, PUT and bulk PATCH evaluate it after
locking the stored row (`FOR UPDATE`, as `expect` does), so a concurrent write
cannot change what it was judged against. Paths that read no stored row (sync
and `ctx.db` updates) refuse a write that sets the field: fail closed rather than
judge against nothing. Transition rules sit outside rule groups.

### Installing and trusting code

1. **The signature is checked at every load**, not only at download. The tier
   is read from the signed catalog entry, never derived from the name. Today
   `isFirstParty` matches name prefixes (`extension-sandbox.ts:158`). It is
   unproven whether a sideloaded `storage/x` gets first-party treatment; it is
   tracked as a separate finding.
2. **Profiles**, chosen by the operator in env and never in the UI:
   - **`development`:** anything goes, unsigned allowed; refused under
     `NODE_ENV=production`.
   - **`standard`:** signed code only, revocations enforced, install from the UI
     or the CLI.
   - **`locked`:** production loads only what a host-side lockfile names
     (name, version, digest, granted capabilities and forward maps). The UI is
     read-only for extensions.
3. **God step-up.** Every extension mutation needs a fresh passkey assertion
   with user verification, or a TOTP code whenever TOTP is enrolled (no password
   fallback — owner decisions 2026-10-18; passkey only in `locked`). Implemented in `lib/step-up.ts`.
   - Passkey and TOTP are already wired in `lib/auth.ts`; enforcement goes in
     `requireGod` (`extension-marketplace-routes.ts`).
   - No approver role is added under god.
4. **Egress approval** names domains. Deno enforces it for jobs. The process
   backend enforces it through a per-extension egress proxy (Host/SNI allowlist,
   DNS pinning), because today's runner filters only by IP (`ext-runner.ts:500`).

### Developer platform

- **Local:** `zveltio extension dev` runs a local engine in the `development`
  profile.
- **Registry, automatically on publish:**
  - a reproducible build;
  - the extension's own tests, run isolated;
  - static checks (no SECURITY DEFINER, no untrusted PL, no `ctx.internals`);
  - a dependency scan;
  - a capability diff against the previous version.

  An extension that passes is published at level 2.
- **Certification:** a human review of code and capabilities, per version, which
  promotes it to level 1. That is feasible while publishers are few.

### A proprietary runtime later

It would be one more backend under the same contract, so extensions written for
v1 run on it unchanged. Revisit it when all of these hold:
- a hosted multi-tenant cloud runs more than about 500 warm third-party
  instances per node;
- per-invocation billing is a revenue line;
- 50 or more third-party publishers are active;
- a team has two engineers dedicated to the runtime and its security.

The estimate today is 10–13 engineer-months to build, and 0.3–0.5 FTE to keep
up with V8. A proprietary *language* is not planned: Shopify retired its DSL
(Scripts) for Wasm Functions.

## Engine work

The estimates are in engineer-weeks for the engine, from the code as it stands.

| Phase | Work | Weeks |
|---|---|---|
| **A. Close today's gaps** (no dependency on the rest) | signature + digest verified at load, tier from the signed catalog (`load.ts`, `load-phases.ts`, `extension-sandbox.ts`); verified tier stops running inline; profiles; god step-up in `requireGod` | 1–2 |
| **B. Contract** | `extension-api v1` types in the SDK; `host.collections` on the data write pipeline (permissions, RLS, column rules, flows, audit); the action primitive (manifest, route, Casbin `execute`, audit, request transaction); outbox table and dispatcher (migration); ctx v3 replacing `ctx.internals` (85 call sites, 47 extensions use `ctx.db`) | 5–7 |
| **C. Rules** | CEL adopted for validation, transitions and flow `condition`; migration of stored rules | 2–4 |
| **D. Backends** | the process backend speaks `host.*` over IPC instead of `db:query` (reuses `ext-runner.ts` supervision); the Deno job runner (spawn, permissions from the manifest, memory flag, timeout); the per-extension egress proxy | 4–6 |
| **E. Delete** | third-party `db:query`, the request-transaction bridge, `worker-extension-ctx.ts` parity, most of `worker-extension-host.ts`, the text SQL policy for third parties: about 2,500–3,000 lines and 8–10 harness tests | 1–2 |
| **Engine total** | | **13–21** |

Outside the engine:
- **The 55 first-party extensions** move to collections and actions (hand-written
  CRUD deleted). CRM goes first, as the pilot that validates the contract before
  v1 is frozen. Estimate: 6–10 weeks.
- **Registry:** the automated pipeline and the certification flow.

**Order and rc.1** (owner decision 2026-10-17: every engine phase lands before rc.1):
1. **A** starts now, together with the fix for CRM's skipped data flows (an
   independent bug).
2. **B** at its minimum: collections, actions, `host.collections` and the
   outbox. UI and the service broker stay as they are and join in v1.x without
   breaking anything. The CRM pilot runs alongside, to find the contract's gaps
   before v1 is frozen.
3. **C** opens with a week that runs the official CEL conformance tests against
   the JavaScript implementation.
4. **D** and **E.**
5. rc.1.
6. The remaining first-party extensions are migrated, and the registry pipeline
   is built.

## Measurements

These are scripts to rerun; they are not in this repository.
- **Actions:** the same `issueInvoice` action run inline, in a Bun child process
  over JSON lines, in an SES `Compartment` inside a Worker, and in QuickJS-WASM
  with Promise-returning host calls. Each was warmed with 100 calls; then 1,500
  actions at concurrency 10. CPU is `process.cpuUsage()` plus the child's
  `/proc/<pid>/stat`.
- **Raw SQL escape:** under `SET LOCAL ROLE <ext role>` with FORCE RLS on a
  tenant GUC, the extension ran `set_config` and `RESET ROLE`.
- **Jobs:** an escape script, run under Deno `--no-prompt --allow-net=<engine>`,
  Node `--permission`, Supabase Edge Runtime and workerd with a `globalOutbound`
  gate.
- **CEL conformance** (phase C, week 1, 2026-10-19): the official cel-spec
  simple tests, as `@bufbuild/cel-spec` 0.6.1 ships them (2,344 tests), run
  against `@bufbuild/cel` 0.6.1 and `@marcbachmann/cel-js` 8.0.0. Tests that
  need protobuf messages or a container (594) were left out, because rules
  evaluate over records, not messages. Of the 1,750 that ran:
  - `@bufbuild/cel` passed **every core-language suite**: literals, equality and
    ordering across numeric types, conversions, `int64`/`uint64` overflow,
    strings, bytes, maps, lists, `has`, macros, timestamps, durations, errors.
    What failed was optional extensions the run did not load or the library
    does not ship: math, bindings, `cel.block`, two-variable comprehensions,
    optionals, encoders (about 350 tests). Two core misses: backtick-quoted
    field names (a recent spec addition) and one heterogeneous map-key case.
  - `@marcbachmann/cel-js` failed 661, many in the core: wrapper equality,
    numeric conversions, `quote`/`format`, duration and timestamp ranges,
    receiver-style calls.

## Decisions

Owner, 2026-10-17.
1. **Level 1 (certified) actions run inline**, with three conditions:
   - data is still reached only through `host.collections` with declared
     capabilities;
   - certification is per version;
   - revocation stops the extension everywhere.

   Certification starts with contracted partners only.
2. **No SQL for third-party code.** `host.collections` is the only data path in
   `extension-api v1`; `db:query` stays first-party only.
3. **CEL**, provided a JavaScript implementation passes the official
   conformance tests in phase C's first week. If none does, freeze
   expr-eval-fork behind a typed wrapper with decimals. Either way the choice is
   made before rc.1.
   **Result (2026-10-19): `@bufbuild/cel` passes** (see Measurements), so CEL
   is adopted, pinned to an exact version since the library is pre-1.0. Two
   things the proposal assumed do not come with it, and the engine supplies
   them:
   - **No cost estimate.** CEL cannot loop forever, but nested
     comprehensions grow with their input. Limits are the engine's: expression
     length, and comprehension nesting checked on the parsed AST when a rule is
     saved.
   - **No public type checker** (one exists internally, not exported). A rule
     is parsed and evaluated against a sample record when it is saved; a type
     error otherwise shows at evaluation time.
4. **Deno is the job runtime**, added in phase D as an optional component
   fetched when the first job-capable third-party extension is enabled. It is
   not bundled in every install. First-party jobs may run inline.
5. **Phases A–E all land before rc.1.**
