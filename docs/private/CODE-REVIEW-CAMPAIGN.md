# The file-by-file code review campaign

> **Started:** 2026-09-04, against `3.0.0-beta.64`.
> **Why:** several audit rounds each found real defects — and each one sampled.
> Sampling keeps finding defects because the corpus has never been read end to
> end. This campaign reads it: every file, every line, once, with a name and a
> date against it.
> **Size:** 60 sections, 645 files, ~131,000 lines of product code, plus 849
> test files (~91,000 lines) reviewed inside the sections that own them. The
> count moves when a branch catches up with master; a closed section reopens if
> the merge brings it a file, which is the intended behaviour, not a bug.
> **Cadence:** one section per session. Nobody finishes this in one sitting, and
> nobody should try.

The checklist itself is [`CODE-REVIEW-STATE.md`](./CODE-REVIEW-STATE.md) —
generated, never edited by hand. The ledger you write to is
[`code-review-status.json`](./code-review-status.json). Regenerate with
`bun run review:inventory`.

---

## The rule that governs the whole campaign

**Do not believe anything you have not seen run.**

Green tests, green CI and code that looks right have coexisted, in this
repository, with: an extension reporting "Submitted to ANAF" without sending
anything; a migration command reporting success while applying nothing; a
dashboard reporting zero collections on an instance that had all of them; and a
`prepush` gate chain wired to no hook at all. Reading found none of those.
Running found all of them.

So when a check below says *verify*, it means execute the path — a request, a
command, a query against a real database. "I read the function and it looks
correct" is not a verified section, and the ledger has a `ran` field precisely
so that this cannot be faked by omission.

The second rule follows from the first: **a section may close with "nothing
found"**. That is a real and frequent outcome. Do not manufacture findings to
justify the session — a fabricated finding costs more than a missed one,
because the next person trusts it.

---

## What one session looks like

A session is one section, start to finish. Do not start a second one.

**1. Claim it.** Run `bun run review:inventory` — it prints `NEXT SECTION: <id>`
and the same answer appears under *Next up* at the top of `CODE-REVIEW-STATE.md`.
That is your section; do not pick your own. A section stays open until every one
of its files carries a tick, so a `partial` one comes back to the front of the
queue and you continue it. Check `ListAgents` — if another agent is working this
checkout, coordinate before touching git.

**2. Set up a clean surface.**

```sh
# Your own test database — two sessions on one database destroy each other,
# and the failures look like regressions, not collisions.
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/zveltio_review_<section>
scripts/setup-test-db.sh          # first time on this machine only
pgrep -af "bun test packages"     # someone else already running? wait.
```

Never `pkill -f index.ts` — port 3000 is the `/opt/zveltio` instance. Use
`:3200` for a scratch engine and `:3099` for the integration lane. `bun x`, not
`bunx`. The Studio needs `svelte-kit sync` before it type-checks.

**3. Read every file in the section, top to bottom.** Not skimmed, not grepped.
The section is sized so that this fits in one session — most are under 2,500
lines. While reading, run the failure-class checklist below against what you
see; it is ordered by how often each class has actually bitten this codebase.

**4. Open the tests that claim to cover it.** For each significant behaviour,
find the test and ask one question: *would this test fail if the behaviour
broke?* A test that mocks the thing under test, or that asserts the shape of a
response rather than its effect on the database, is a green light wired to
nothing. Record every test file you opened in `tests` — the leftovers are the
T01 backlog.

**5. Run something.** At minimum, the suite covering the section and the gates
that claim to protect it. Record the command *and its result* — including
failures. If it does not run, say so; `blocked` is a valid verdict.

**6. Fix what is safe to fix here.** See the repair policy below.

**7. Record the session** in `code-review-status.json`, run
`bun run review:inventory`, and stop. Do not commit without the owner's
approval.

---

## The failure-class checklist

Every entry is here because it happened in this repository. The greps are
starting points, not the review.

### 1. Reported success that did not happen

The most expensive class: it writes a false state into the database and the
proof of compliance becomes the proof of the lie.

- Fabricated identifiers or responses: `Date.now()` as an id, `Math.random()`,
  `// Stub`, `// in production`, a status set to *sent* / *completed* on a path
  that never called anything.
- The `catch:fabricated` gate holds this class at zero in both repositories.
  Verify it still does for your files, and that no `// fabricated-ok:`
  annotation has drifted from its reason.
- **`gzip.exitCode` was unchecked on both backup paths**: a truncated dump was
  recorded as `completed`. Check every exit code, every `await`ed process, on
  any path that reports an outcome.
- **A script that edits source by string replacement is in this class.** On the
  day this campaign opened, four `str.replace(old, new, 1)` calls in its own
  tooling matched nothing — an intervening `check:fix` had reformatted the
  arrays they anchored on — returned the input unchanged, exited 0, and reported
  placements that did not exist. `replace` has no failure mode: it returns the
  string either way. Assert the anchor occurs exactly once before replacing, and
  verify the *effect* afterwards, not the presence of the text. Several scripts
  under E04 and E05 edit source this way.

### 2. Swallowed failures

```sh
grep -n "catch (\s*)\s*{\s*}\|\.catch(() => \(0\|\[\]\|null\|{}\))" <files>
```

A `.catch(() => 0)` around a query returns a *credible* zero. Worse: in
Postgres a failed statement aborts the whole transaction, so the swallowed
error resurfaces later, somewhere unrelated — a bad table name in a stats panel
once became a false 401 on login. Keep the fallback if a 500 is not warranted,
but log the failure *with the name of what failed*.

### 3. Transaction boundaries

- A `return` inside a transaction callback **commits**. Read every early return.
- A second connection reserved inside a request that already holds one:
  `/api/insights` froze the pool at `DB_POOL_MAX` with 10 connections `idle in
  transaction` and zero `active`. Gates: `check:pooldb-txn`,
  `check:tenant-on-pool`, `check:atomic-writes`.
- A GUC survives as `''` after `SET LOCAL` + `COMMIT`, so *absence* of the
  tenant context is not detectable by reading it back. Any code that infers
  "no tenant" from an empty GUC is wrong.

### 4. Tenant isolation

- Tenant data must go through `createRequestScopedDb`. `poolDb` on a
  tenant-scoped table is a leak with a gate: `check:tenant-on-pool`.
- Unique constraints must carry `tenant_id` in `conkey`. Sixty were written
  without it; tests never caught them because tests run as a single tenant.
- Isolation by join only — a child table with no tenant column of its own —
  is a second line that does not exist. Nine such tables are known.
- Any denylist over an open namespace leaks: Better-Auth tables escaped three
  separate prefix denylists. **Allowlist, never denylist.**
- Presence, caches and rate-limit buckets are tenant state too. The leak found
  on 2026-08-27 was on the *no-Valkey* path, which the reading audit skipped.

### 5. Authorisation

- Every admin route needs its guard; the method is to grep for the helper and
  then read the sibling routes that do not call it.
- Deny by default. `manifest.resources` is not `manifest.permissions`.
- `hidden` columns are filtered from reads but `filterWritableFields` consults
  only `readOnly` — a role that cannot see a column can still write it blind.
- Reserved fields: `created_by` / `updated_by` were cut by the `RESERVED` list
  and `tenant_id` was accepted from the request body.

### 6. SQL construction

`sql.id()` for identifiers, parameters for values, no string concatenation.
Gates: `check:raw-sql`, `sql:backticks`, `sql:numeric-arith`. One
`CREATE POLICY` still wraps a table name in bare quotes while every sibling
statement in the same file uses `sql.id()`.

### 7. Schema against code

- Compare every `INSERT` / `UPDATE` column list with
  `information_schema.columns` on a live database. Ten extensions wrote columns
  that did not exist; the two basic operations of a whole module were dead.
- When schema and code disagree, **the schema is usually right** — renaming
  columns that may already hold data to match newer code is a repair in the
  wrong direction.
- Two creators for one table: the engine creates it, the extension's migration
  creates it differently, and whichever runs first wins. Gate:
  `check:table-owners`.

### 8. Generated artifacts edited at the destination

Editing a generated tree is erased by the next build, silently. Three trees
exist for the extension snapshot — the third is in `packages/client`. Source
first, then regenerate: `gen:migrations`, `studio:build && studio:embed`,
`check:ext-snapshot`, `check:schema-snapshot`.

### 9. Dead code and dead branches

Whole features have been dead: `ZVELTIO_REQUIRE_CATALOG` never fired,
`hasCapability` was never called, `byod /stats` queried a table that never
existed. A discontinuity in coverage hits across an `if` is a reliable detector.
Do not delete on suspicion — prove it is unreachable, then delete.

### 10. Concurrency and fencing

Anything scheduled must survive a second replica. The backup scheduler is the
one component still without fencing. Check leader election, advisory locks, and
what happens when two instances fire the same cron minute.

### 11. Resource shape

Unbounded queries, missing `LIMIT`, N+1 in loaders, a filter with `ORDER BY`
that discards 300,000 rows to return 25. This class costs from *ten* tenants
upwards, not from a thousand — it is a plan cliff, not growth. `EXPLAIN` the
query you are suspicious about; do not reason about it.

### 12. Test honesty

- Suites that self-skip when an env var is missing and report green.
- `mock.module` leaking between files (a documented flake source here).
- Bun's file order is `readdir` order, not alphabetical, and it ignores `argv`
  ordering — tests that depend on order are already broken.
- Tests that dial the real registry: run with `REGISTRY_URL=http://127.0.0.1:9`
  or a 5-second fetch becomes a 5-second timeout in a different file each run.

### 13. A test that passes for the wrong reason

The dominant failure this campaign has found — four independent instances on
2026-09-05 alone, in two repositories, by two sessions.

- Thirty engine tests called `runQualityScan` with no tenant and passed **because
  of** the root-tenant default they should have caught. They encoded the defect.
- `hydrate.test.ts` stayed green (47/47) with the `zvd_` prefix guard removed —
  the exact shape of the 2026-08-16 vulnerability. A registry check upstream
  carried the tests; what the prefix defends is the case the registry cannot.
- `oauth-flow.test.ts` stayed green after a config table moved, because the
  migration had adopted a row an earlier run seeded. It only failed on a database
  built from zero.
- `demo-mode-blocked-paths.test.ts` was green while the middleware was fully
  bypassable, because it handed the middleware a hand-built `{ req: { url,
  method } }` with no `req.path` — it measured the pattern list, not the gate.

The tell is the same each time: the test exercises a **path near** the guard
rather than the guard, so something else upstream produces the expected answer.

**The method that finds it is cheap and should be routine, not reserved for
suspicion: remove the guard, demand the test fail, put it back.** One edit, one
run, one revert. A check that passes with the fix removed is not evidence, and
"the suite is green" says nothing about which of its assumptions is load-bearing.

Two failure modes of the method itself, both met here: a revert that breaks the
file's *syntax* makes every test fail for that reason and proves nothing — the
failure must be the named case, not an unnamed hook. And an anchor that no longer
matches (auto-formatting moves code between writing the revert and running it)
silently reverts nothing, so assert the anchor occurs exactly once.

### 14. A closed finding protects the code that was read, not the file name

A finding is closed against the lines somebody looked at. It says nothing about a
second copy, or about code written afterwards that reaches the same sink.

Three instances so far, and one of them is from a repair made during this
campaign:

- The two API-key revocation handlers are twins with the same body. The first was
  fixed, and the probe still answered 200 — because `/api/admin/api-keys/:id` and
  `/api/api-keys/:id` are served by different routers. Found only by re-measuring
  after the fix rather than by reading it.
- `communications/mail` rendered inbound email with `{@html}` behind a regex that
  stripped a literal `<script>` and nothing else. Eleven of twelve payloads
  survived. It exists BECAUSE a "mail iframe XSS" claim was correctly dismissed
  on 2026-08-02 — and the component that reintroduced it, as `{@html}` rather
  than an iframe, was written three weeks later.
- The `::jsonb` double-encoding class was repaired across a family of writers and
  `lib/notifications.ts` was missed, so the data repair in migration 010 was
  undone by the next notification.

**A variant worth naming, because it is easier to catch and was not caught.** The
twin is not always in another file. Four times in this campaign the correct
pattern and the broken one sat a few lines apart in the same function or the same
file: `PATCH /production/:id/start` doing `WHERE id = … AND status = 'draft'
RETURNING *` two handlers above a `complete` that read then wrote; the
single-record write path awaiting `afterWrite` while the bulk path beside it did
not; the two API-key revocation handlers. Proximity reads as consistency. A file
that gets one case right is where nobody looks for the case it gets wrong.

**What follows for the method.** When a repair is made, ask what else has the
same shape and go and look — a grep for the sink, not for the file, and then a
read of the neighbours. When a finding is dismissed, record what was examined, so
the next reader can tell "this code is safe" from "this code was safe in August".
And after any fix, re-run the measurement that found the defect: a second copy
answers the same probe the same way, which is how the twin above was found.

### 15. Frontend-specific (Track C)

Svelte 5 runes only; `$effect` loops; unsanitised HTML (`{@html}`) against
`lib/sanitize.ts`; API calls that bypass `$lib/api.js`; permission guards that
merely hide a control the server would accept; hardcoded strings where a message
key belongs.

---

## Repair policy

**Fix in the session** — a defect whose repair is contained in the files of your
section, has a test that fails before and passes after, and does not change a
public contract.

**Log, do not fix** — anything that changes the SDK surface, a manifest
contract, a migration already shipped, or that touches files outside your
section. Write it into
[`../platform/known-gaps.md`](../platform/known-gaps.md) with the marker it
deserves, and reference it from the ledger entry.

**Never** — do not edit `quality-gates/*.json` baselines to make a gate pass, do
not widen a test to accept the current behaviour, and do not commit without the
owner's explicit approval. Branch per section: `review/<section>-<slug>`.

Every repair needs a test that would have caught the defect. A fix without one
is a fix that comes back.

**When two sections land together, run both their tests before you believe
either.** On the first day, E04 tightened `require-sibling` to reject an empty
directory, and that was correct — but an E01 fixture built its fake sibling as
exactly that, so folding the two branches produced a failing test neither
section had on its own. Neither author was wrong and neither could have seen it
alone. Whoever merges owns that run — and it is the two sections' own harness
files, not the full suite: 30 tests and about a second, which is the property
that makes a rule get followed.

---

## Recording a session

Write **one file per session** under `docs/private/review-sessions/`, named
`<section>-<date>-<n>.json`, holding a single object:

```jsonc
{
  "section": "A04",
  "date": "2026-09-04",
  "agent": "claude-opus-5",
  "branch": "review/A04-tenancy-core",
  "files": [
    "packages/engine/src/lib/tenancy/tenant-manager.ts",
    "packages/engine/src/lib/tenancy/tenant-context.ts"
  ],
  "tests": ["packages/engine/src/tests/unit/tenant-context.test.ts"],
  "ran": [
    "bun run test:unit src/tests/unit/tenancy — 412 pass, 0 fail",
    "bun run check:tenant-on-pool — clean",
    "psql: SELECT current_setting('app.tenant_id', true) after COMMIT — returns ''"
  ],
  "findings": [
    {
      "severity": "high",
      "where": "lib/tenancy/tenant-manager.ts:812",
      "what": "CREATE POLICY interpolates the table name with a bare quote wrap",
      "status": "logged",
      "ref": "known-gaps.md §1"
    }
  ],
  "notDone": "The hierarchy path needs a two-level fixture; no such fixture exists yet.",
  "verdict": "repaired"
}
```

`files` lists what you actually read line by line — that list is the coverage
number, so listing a file you skimmed corrupts the only measurement this
campaign has. `verdict` is one of `clean` (nothing found), `repaired` (found and fixed),
`logged` (read in full, findings recorded, nothing fixed here — the honest label
when the repair belongs to another section or would land unreviewed), `partial`,
`blocked`.
A `partial` section stays open and the next session continues it; only the files
you listed count as done.

A file per session, rather than one array for all of them, because the single
ledger conflicted on **every** section branch — four times on the first day — and
each resolution was a hand-merge of a findings document. A hand-merge that
happens on every branch eventually drops a section. Two branches writing two
filenames do not conflict at all.

Then run `bun run review:inventory`. If it exits non-zero, a tracked file
matches no section — place it in `scripts/review-inventory.ts` before finishing.

---

## Order of work

**The order lives in `ORDER` in `scripts/review-inventory.ts`, not here** — so
that the generator can name the next section and two agents on two machines pick
the same one. A section missing from `ORDER` fails the generator.

The phases, and why they are in this order:

**Phase 0 — what enforcement actually exists.** `E01`, `E02`, `E04`, `E08`.
Before trusting any gate's silence, find out which gates run, on which event,
and which of them report clean when their input is missing. Seven were
fail-open at the last count, and the meta-gate ran nowhere. Cheap sections, and
everything after them inherits the answer.

**Phase 1 — isolation and authorisation.** `A04`, `A05`, `A06`, `A02`, `A07`,
`A16`, `A11`. The class with proven cross-tenant leaks.

**Phase 2 — data integrity.** `A08`, `A09`, `A10`, `A12`, `A13`, `A14`, `A15`,
`A17`, `A01`, `A03`.

**Phase 3 — the code that runs other people's code.** `B03` first, then `B01`,
`B02`, `B04`, `B05`.

**Phase 4 — subsystems that report outcomes.** `B10`, `B08`, `B11`, `B12`,
`B06`, `B07`, `B09`, `B13`.

**Phase 5 — surfaces.** `C01`–`C14`, then `D01`–`D07`.

**Phase 6 — the rest of the harness.** `E03`, `E05`, `E06`, `E07`, `E09`.

**Phase 7 — the leftovers.** `T01`: the test files no section opened. The
generator falls through to this once every section is closed.

A later phase may be pulled forward when something in an earlier one points at
it — edit `ORDER` and say why in `notDone`, so the order stays legible.

---

## The parallel reading pass

A second audit ran on the same tree on the day this campaign opened, with a
different shape: ten thematic sessions, one living document,
[`../../AUDIT.md`](../../AUDIT.md). It produced 111 observations and five
repairs, all five now on this branch (`d12b6480`, `333db6b6`, `e92fdc42`), and
two of them closed known-gaps entries that had been open for days — hidden
columns being writable, and the DDL identifiers in `tenant-manager.ts`.

**Use it as a map, not as coverage.** Its observations are code reading; its
verification blocks run lint, typecheck and test suites, which prove the tree
builds, not that the described behaviour was exercised. No section is ticked in
`CODE-REVIEW-STATE.md` on its account, and that is deliberate — ticking them
would record 111 unrun claims as verified work and destroy the only measurement
this campaign has.

Where it is worth reading before you start a section:

| AUDIT.md session | Sections it read into |
|---|---|
| 1 — bootstrap & request lifecycle | `A01`, `A02`, `A03` |
| 2 — tenancy, RLS & security | `A04`, `A05`, `A06` |
| 3 — data layer | `A11`, `A12`, `A13` |
| 4 — extensions & sandbox | `B01`–`B05` |
| 5 — auth & sessions | `A07` |
| 6 — background services | `B06`, `B07`, `B08` |
| 7 — storage & AI | `B09` |
| 8 — Studio & SDUI | `C01`–`C03` |
| 9 — SDK & CLI | `D01`–`D07` |
| 10 — extensions catalog | the sibling repository, `X01` here |

Its open TODOs are the cheapest leads a section can start from — they name what
the reader noticed and did not chase.

---

## What this campaign does not cover

- **The 56 first-party extensions.** They live in `../zveltio-extensions` and
  have their own checklist (`REVIEW-CHECKLIST.md`) and their own status file.
  A pass there was completed on 2026-08-12; it needs a re-run, not this plan.
  Sections `X01` account for their destination copies here — editing those is
  erased by the next sync.
- **Generated artifacts** (`X02`). The section owning the generator answers for
  its output.
- **Documentation.** Wrong documentation is a finding; fixing the chapter is not
  part of the session.
- **Dependencies.** Their own procedure exists; see the dep-bump notes.

---

## Definition of done

The campaign is finished when `CODE-REVIEW-STATE.md` reports every file of
every section reviewed,
every section has at least one session with a verdict that is not `blocked`, and
`T01` reports zero unread test files. At that point the honest statement is
"every line has been read once, by someone, on a recorded date" — which is a
much weaker claim than "the code is correct", and is exactly the claim this
campaign is designed to be able to make.
