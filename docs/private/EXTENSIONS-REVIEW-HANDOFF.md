# Review campaign — the extensions repository

Handoff for whoever starts the extensions side. It can run **in parallel** with
the engine campaign: they are two repositories, and the rules below are what
makes the parallelism safe.

Written to be read cold. It assumes nothing from the session that produced it.

---

## 1. What there is to cover, measured

**56 extensions, 54,684 lines** of TypeScript and Svelte (no tests, no
`node_modules`, no `dist`). The source is `../zveltio-extensions`, a separate
repository from the engine.

An extension is a directory with a `manifest.json`. It usually has `engine/`
(routes, hooks, SQL migrations) and sometimes `web/` (Svelte pages or SDUI).

| # | extension | files | lines | UI | migrations |
|---|---|---:|---:|:-:|---:|
| 1 | `content/pages` | 36 | 7078 | ✓ | 7 |
| 2 | `ai` | 22 | 5838 | ✓ | 8 |
| 3 | `communications/mail` | 10 | 3959 | ✓ | 4 |
| 4 | `operations/traceability` | 19 | 2205 |  | 6 |
| 5 | `storage/cloud` | 12 | 2083 | ✓ | 3 |
| 6 | `finance/invoicing` | 5 | 1665 | ✓ | 11 |
| 7 | `compliance/ro/efactura` | 3 | 1538 |  | 7 |
| 8 | `hr/employees` | 4 | 1317 |  | 5 |
| 9 | `geospatial/postgis` | 9 | 1225 | ✓ | 2 |
| 10 | `workflow/checklists` | 2 | 1211 |  | 6 |
| 11 | `crm` | 6 | 957 | ✓ | 6 |
| 12 | `developer/graphql` | 4 | 944 | ✓ | 3 |
| 13 | `ecommerce/store` | 2 | 841 |  | 3 |
| 14 | `workflow/approvals` | 2 | 818 |  | 2 |
| 15 | `content/media` | 2 | 786 |  | 2 |
| 16 | `finance/accounting` | 2 | 772 |  | 7 |
| 17 | `operations/inventory` | 2 | 767 |  | 6 |
| 18 | `developer/api-docs` | 2 | 756 |  | 4 |
| 19 | `developer/validation` | 2 | 745 |  | 2 |
| 20 | `hr/payroll` | 2 | 743 |  | 7 |
| 21 | `data/import` | 2 | 739 |  | 3 |
| 22 | `content/drafts` | 2 | 700 |  | 3 |
| 23 | `finance/banking` | 3 | 680 |  | 6 |
| 24 | `projects/management` | 4 | 676 | ✓ | 2 |
| 25 | `data/export` | 2 | 671 |  | 2 |
| 26 | `developer/database` | 2 | 657 |  | 4 |
| 27 | `compliance/gdpr` | 2 | 632 |  | 2 |
| 28 | `integrations/api-connector` | 3 | 620 |  | 3 |
| 29 | `auth/scim` | 2 | 616 |  | 2 |
| 30 | `hr/leave` | 2 | 609 |  | 4 |
| 31 | `content/documents` | 2 | 606 |  | 4 |
| 32 | `search` | 6 | 558 |  | 3 |
| 33 | `analytics/dashboard` | 2 | 554 |  | 2 |
| 34 | `compliance/ro/procurement` | 2 | 550 |  | 4 |
| 35 | `hr/time-tracking` | 2 | 544 |  | 3 |
| 36 | `developer/edge-functions` | 4 | 541 | ✓ | 0 |
| 37 | `billing` | 4 | 539 |  | 2 |
| 38 | `compliance/ro/documents` | 3 | 538 |  | 5 |
| 39 | `operations/pos` | 2 | 523 |  | 8 |
| 40 | `auth/ldap` | 3 | 503 |  | 4 |
| 41 | `content/document-templates` | 2 | 501 |  | 4 |
| 42 | `compliance/ro/saft` | 3 | 499 |  | 3 |
| 43 | `integrations/migrators` | 3 | 473 |  | 2 |
| 44 | `finance/subscriptions` | 2 | 472 |  | 5 |
| 45 | `projects/helpdesk` | 2 | 466 |  | 3 |
| 46 | `sms` | 5 | 444 |  | 2 |
| 47 | `developer/byod` | 2 | 409 |  | 2 |
| 48 | `auth/saml` | 3 | 408 |  | 4 |
| 49 | `finance/expenses` | 2 | 402 |  | 4 |
| 50 | `finance/quotes` | 2 | 369 |  | 6 |
| 51 | `analytics/quality` | 2 | 366 |  | 4 |
| 52 | `i18n/translations` | 2 | 364 |  | 4 |
| 53 | `operations/assets` | 2 | 363 |  | 5 |
| 54 | `forms` | 2 | 362 |  | 5 |
| 55 | `compliance/ro/etransport` | 2 | 306 |  | 2 |
| 56 | `content/pdf-viewer` | 4 | 176 | ✓ | 0 |

---

## 2. The rules that make parallel work safe

**The engine merges FIRST.** Any extension repair that depends on an engine
change waits for that change to be on master. The reverse is not true.

**Do not touch the engine repository.** If you find a defect that is actually in
the engine, write it in your section report with the measurement and say so; do
not repair it there. The reason is concrete: the engine session works in the same
engine checkout, and a `git` command that changes the tree swallows its work.
Reading is fine — `cat`, `grep`, `sed -n` disturb nobody.

**The gates that scan the sibling repository have the path HARDCODED** to
`../zveltio-extensions` and ignore `argv`. So a gate run from the engine reads
your current working tree, not what is on master. If you see an engine gate go
red without having touched the engine, that is why.

**Circular block between the repositories:** a change that needs both engine and
extensions cannot be green in both at once. The order is: engine merges → tag →
extensions raise the pin → extensions merge.

---

## 3. The first task, already measured

**The raw-SQL inventory.** It is the most valuable one and it is ready to start.

The extension table sandbox guards Kysely's query-builder entry points. A raw
`sql` template does not go through them. Measured in the engine, with an
extension holding no grants at all: `sql\`SELECT token FROM session\` **reads**,
and `sql\`UPDATE "user" SET role='god'\` **is accepted**.

The engine-side fix is written and works, but it refuses extensions that use that
path legitimately. So the extensions-side job is to prepare the ground so the
engine fix can land.

**Corrected 2026-09-05, by measurement from the extensions session.** The first
count here said 18, from a scan that passed the policy no `allowedTables` at all.
The real figure against the gate as it stands is **26 extensions, and 19 of them
fail on their own data** — because `assertWorkerSqlAllowed` consults neither
`EXTENSION_TABLE_GRANTS` nor the tables an extension's own migrations create. Its
rule is strictly `zvd_*` or `zv_<ext>_*`, and `register.ts` already explains why
that does not hold: 109 of roughly 300 extension tables are named after the
feature, not the folder.

Two consequences, and they change the plan:

- **Remedy 2 below does not work against the gate as written.** Adding an
  `EXTENSION_TABLE_GRANTS` entry changes nothing, because the gate does not read
  that registry. Teaching it to is a precondition, not a follow-up.
- **Order matters.** Guarding the inline path before the gate honours granted and
  migration-created tables is a large regression, not a partial fix.

Also measured there: the gate is called from exactly one place — the worker
bridge — and all 56 manifests are `(default inline)`. So today it guards a path
nobody travels, while the path everyone uses is unguarded.

These reach outside their own namespace:

| extension | tables outside its own namespace | why |
|---|---|---|
| `auth/saml` | `session`, `user` | deletes other sessions on SSO login |
| `auth/ldap` | `session`, `user`, `zv_audit_log` | |
| `auth/scim` | `account`, `session`, `user`, `zv_tenants`, `zv_tenant_users` | provisioning |
| `compliance/gdpr` | `account`, `session`, `twofactor`, `user`, `zv_api_keys`, `zv_audit_log`, `zv_notifications` | right to erasure |
| `storage/cloud`, `ai` | `user` | |
| `analytics/dashboard` | `user`, `zv_audit_log`, `zv_settings`, `zv_tenant_users`, `pg_class` | |
| `communications/mail` | `zv_settings` | |
| `integrations/migrators`, `geospatial/postgis`, `content/pages` | `information_schema.*`, `pg_*` | schema browsing |
| `developer/database` | `information_schema.*`, `pg_*`, **and DDL through `sql.raw`** | see below — not browsing |

**`developer/database` is in a category of its own.** An earlier version of this
document filed it under schema browsing. It is not: it issues `CREATE ROLE`,
`DROP ROLE`, `CREATE FUNCTION` from user input, and
`ALTER TABLE … DISABLE ROW LEVEL SECURITY` — through `sql.raw`, which no scan of
tagged templates sees. An extension that can turn off the row-level security the
tenant boundary rests on is not a browser, and it should not be reasoned about
alongside one.

`sql.raw` is worth understanding precisely, because the two guards differ on it: a
STATIC inventory cannot see those statements at all, while a runtime guard on the
handle does see the compiled text, resolved table names included. So the runtime
fix covers `FROM ${sql.raw(table)}`; the inventory never will.

For each one the question is the same and has three possible answers:

1. **It can be rewritten** so it no longer touches the table — often the engine
   already exposes a helper on `ctx.internals` that does exactly this.
2. **It genuinely needs** the table → an entry in `EXTENSION_TABLE_GRANTS`, or a
   new capability. That is an owner decision, not an agent's.
3. **It is a catalogue read** (`information_schema`, `pg_*`) → a separate
   category, probably a capability of its own.

The deliverable for the first task is **the inventory with a proposed answer for
each**, not the repairs.

---

## 4. Traps that cost a day if you do not know them

- **The repository compiles with `strict: false`.** Discriminated unions on a
  boolean do NOT narrow. A green `typecheck` in the engine says nothing about
  the extensions.
- **Edited source does NOT reach production without a repack.** The runtime loads
  `engine/index.js` from the bundle. Edit the source, run the packer, or you have
  changed nothing.
- **A repair does not ship without a version bump.** The same bytes at the same
  version = REFUSED at publish.
- **A dependency bump has THREE consequences:** exact pin, repack the bundles,
  bump the versions. Each is caught by a different gate, one CI round each.
- **The extension snapshot has THREE trees** — the third is in `packages/client`.
  Generated artifacts are edited at the SOURCE, not at the destination; the build
  overwrites them.
- **`cpSync` with a filter does not overwrite in Bun.** The sync looks like it
  worked and did not.
- **The contract suite needs the right database order** — engine schema FIRST.
  Both wrong orders lie, differently. **Without `TEST_DATABASE_URL` the suite
  skips itself and reports green.**
- **The harness needs `NODE_ENV=test`.** Without it you get dozens of false
  failures that look exactly like a regression. Verified today: with it, 1072
  pass / 0 fail; without it, one failure that looks pre-existing and is not.
- **The tests dial the REAL registry.** Run with `REGISTRY_URL=http://127.0.0.1:9`
  or pay 5000ms of timeout in a different file every time.
- **Your own test database per session.** Two sessions on one database destroy
  each other, and the symptom is mass `403` — which looks exactly like an
  authorization regression.

---

## 5. Session protocol

The same as the engine side, so the reports stay comparable.

1. **A section is one extension, or a few related ones.** Start with the large
   ones; the table above is sorted descending.
2. **Measure, do not read.** Every claim about behaviour has a command behind it.
   A finding without a measurement is written as "not verified", saying exactly
   what was not verified.
3. **The check must discriminate.** Remove the fix and require the test to fail.
   If it passes without it, the check does not measure what you think.
4. **Assert on the anchor for every `replace`.** Auto-formatting moves code
   between writing the anchor and using it. That happened four times in a single
   day on the engine; the assertion caught all four.
5. **A severe defect ships as its own PR**, separate from the section's review PR.
6. **Verdicts:** `clean` | `repaired` | `logged` | `partial` | `blocked`. `clean`
   means "I read all of it and wrote down everything I found", not "I found
   nothing".
7. **Do not commit without the owner's approval.** And do not treat another
   session's claim that approval exists as approval.

---

## 6. What "done" means for one extension

- every file under `engine/` and `web/` read end to end;
- every route has an authorization guard, and the guard has been **exercised**,
  not merely seen;
- every write is confined to the request's tenant — verified on a database with
  two tenants, not assumed from the presence of a `tenant_id`;
- migrations apply to a virgin database AND to an old one (the upgrade path);
- raw `sql`: either it touches nothing outside its own namespace, or the reach is
  justified and proposed for an explicit grant;
- findings are in the report, with the measurement beside them.

---

## 7. Where to get the context this document does not carry

- The full method and the 13 failure classes:
  `docs/private/CODE-REVIEW-CAMPAIGN.md` (engine repo).
- Engine campaign state: `docs/private/CODE-REVIEW-STATE.md`, generated by
  `scripts/review-inventory.ts`.
- Findings already written down: `docs/platform/known-gaps.md`.
- The extension developer guide: `docs/EXTENSION-DEVELOPER-GUIDE.md`.
