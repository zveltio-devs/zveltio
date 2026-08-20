# Coverage measurement note — the merged number under-states real coverage

> TL;DR: the gated `lib` coverage % (measured as the **union** of the unit lcov
> and the in-process harness lcov, via `scripts/merge-coverage.ts`) is lower than
> the code is actually tested, because `bun` instruments a **different subset of
> lines per test lane**. Most of the "uncovered" lines in the biggest-gap files
> are a measurement artifact, not untested code. **Writing more tests for those
> gaps does not move the gate.** This note documents the finding so whoever owns
> the coverage gate can decide whether to change the methodology — no change is
> made here.

## What the gate measures

`quality-gates/coverage-baseline.json` ratchets the `lib` bucket of the **honest
combined** surface: the Unit Tests job's lcov UNIONed with the Handler Coverage
(in-process harness) job's lcov (`scripts/merge-coverage.ts` → `coverage-gate.ts`).
The union is per-line: a line counts as covered if **either** lane hit it; the
denominator is the union of all lines **either** lane instrumented.

## The artifact

`bun`'s coverage instruments only the lines reached along the code paths that a
given run actually loads/executes. The unit lane and the harness lane load
different paths, so for the **same file** they instrument **different line sets**:

| file | unit lane | harness lane |
|------|-----------|--------------|
| `lib/data/handlers/single.ts` | 478 lines instrumented, **4%** hit | 364 lines instrumented, **100%** hit |
| `lib/data/handlers/list.ts`   | 296 lines, 5% | 210 lines, 100% |
| `lib/data/handlers/bulk.ts`   | 297 lines, 3% | 247 lines, ~100% |
| `lib/runtime/cache.ts`        | 51 lines, **100%** | 85 lines, 8% |
| `lib/webhook-worker.ts`       | 56 lines, **100%** | 87 lines, 9% |

Because the merge unions the two, a line that the unit lane *instruments but does
not hit* is counted against the total **even when the harness lane executes that
same logic** (but, running a different path, never instrumented that exact line —
or instrumented a different line for it). The net effect: the data handlers
(exercised end-to-end by every harness data test) show ~76% merged despite being
run at 100% in the harness lane; conversely `cache.ts`/`webhook-worker.ts` are
100% in the unit lane but drag the merged number down via the harness lane's
larger, mostly-unhit instrumentation view.

## Implication

- The `lib` code is well tested. The merged ~87–89% under-states it.
- Chasing the biggest "gap" files with more unit or harness tests does **not**
  raise the gate — the lines are already exercised in the other lane, and the
  union denominator doesn't shrink. (A runtime-workers harness PR was opened and
  then closed for exactly this reason: `garbage-collector`/`flow-scheduler`/
  `cache`/`webhook-worker` are already 100% in the unit lane.)
- The plateau near ~88–90% is mostly this artifact plus genuinely external code
  (extension download/npm, S3, OTel, mail) that only runs under integration/soak.

## Options (for the gate owner to weigh — not applied here)

1. **Single combined coverage pass.** Run `bun test src/tests/unit src/tests/harness
   --coverage` in one invocation so bun instruments once, consistently, instead of
   merging two independently-instrumented lcovs. Likely yields a cleaner, higher,
   more honest number. Caveat: the harness lane needs Postgres (+ optionally
   Valkey), so this couples the two jobs / needs the services in one job.
2. **Report per-file max-across-lanes** alongside the union, so reviewers can see
   that e.g. `single.ts` is 100% in the harness lane even when the union says 76%.
   Additive/observability-only; does not change the gate.
3. **Add an integration-lcov lane** — but the integration suite runs the engine
   out-of-process (`localhost:PORT`), so `bun test --coverage` can't capture the
   engine process; this would need engine-process instrumentation and is not a
   quick win.
4. **Leave it.** The ratchet still does its real job (prevents coverage *drops*);
   the absolute number being pessimistic is cosmetic. This is the lowest-risk choice.

## Recommendation

Prefer (4) or (1). Do **not** invest in writing more tests to raise the number —
the gap is a measurement artifact, not missing tests. If a higher honest number
is desired, (1) is the cleanest lever; validate it moves the number before
changing the gate.
