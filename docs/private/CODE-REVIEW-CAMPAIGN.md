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

### 13. Frontend-specific (Track C)

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

---

## Recording a session

Append one object to `sessions` in `code-review-status.json`:

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
campaign has. `verdict` is one of `clean`, `repaired`, `partial`, `blocked`.
A `partial` section stays open and the next session continues it; only the files
you listed count as done.

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
