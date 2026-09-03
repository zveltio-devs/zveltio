# Internal engineering documents

**This is not user documentation.** The documentation is
[`../README.md`](../README.md) and its five chapters. This directory holds
internal engineering material that is either **cited from source code** (and so
must keep a stable path) or is **live planning** for work in progress.

Everything under `docs/` is written in English, these internal notes included —
they are read by the same people and agents as the chapters.

## Cited from source code — do not move

| File | Cited by |
|---|---|
| `HARDENING-9-PLAN.md` | **~1,100 `biome-ignore` comments** across the engine, SDK, Studio and CLI, tracking H-01 (`any`) and H-08 (import boundaries). Moving this file means editing all of them. |
| `EXTENSIONS-V2-PHASE1.md` | `lib/extensions/manifest-schema.ts`, `cli/commands/extension-pack.ts`, `docs/manifest-v2.schema.json` |
| `MULTI-TENANT-ENABLEMENT.md` | `engine/src/index.ts`, `middleware/tenant-membership.ts` |
| `TENANCY-HIERARCHY-DESIGN.md` | `lib/tenancy/tenant-scope.ts`, migration `004_tenancy_hierarchy.sql` |
| `TENANCY-COVERAGE-CLASSIFICATION.md` | migration `004_tenancy_hierarchy.sql` |
| `CASBIN-SCALING-STATE.md` | `scripts/check-tenant-table-on-pool.ts` |
| `OFFLINE-SYNC.md` | `sdk/src/offline/index.ts` |
| `ZVELTIO-VS-SUPABASE-AND-BOUNDARY-AUDIT.md` | `quality-gates/coverage-baseline.json` |

Before moving anything here, run:

```sh
grep -rn "docs/private/" --include="*.ts" --include="*.svelte" --include="*.sql" \
  --include="*.sh" --include="*.json" --include="*.yml" . | grep -v node_modules
```

## Live planning

| File | Status |
|---|---|
| `MATURITY-REFACTOR-PLAN.md` | The campaign plan. Blocks run in the order C → B → F → A; a block may close with "not worth it". |
| `BLOCK-A-EXPLICIT-CONTEXT-STATE.md` | In progress (step 2) |
| `BLOCK-J-DB-SECOND-LINE-STATE.md`, `BLOCK-K-ROW-RULES-IN-DB-STATE.md` | Row rules in the database |
| `BLOCK-L-BIOME-UPGRADE-STATE.md` | Biome 2.5.11 upgrade (PR #381) |
| `BLOCK-M-HONO-LOCKSTEP-STATE.md` | Hono lockstep with the extensions repository (PR #373) |
| `REFACTORING-V1-PLAN.md` | The canonical v1.0 backlog |
| `TECHNICAL-GAPS.md` | The roadmap, with priority and status per item |

Blocks B, C, D, E, F, G and H closed and their state files were removed; their
conclusions are in the documentation chapters and, where they changed code, in
comments at the code they changed.

## Reference notes

| File | Why it survives |
|---|---|
| `COVERAGE-MEASUREMENT.md` | The gated coverage percentage **under-states** real coverage, because Bun instruments a different subset of lines per test lane. Read before writing tests to close a gap that may not exist. |
| `MEMORY_OPTIMIZATIONS.md`, `MEMORY-OPTIMIZATION-BACKLOG.md` | Bun memory tuning findings |
| `ALPHA-TRACK-EOL.md` | Policy for the closed `1.0.0-alpha.*` line |

## What used to be here

Handoff notes, session logs, review briefs and closed block-state trackers were
removed on 2026-09-02, along with the nineteen reports in `audit/`. Their
findings were remediated, re-verified against source, and what survived
verification is in [`../platform/known-gaps.md`](../platform/known-gaps.md).
The rest lives where it belongs: as a comment at the line that fixes the bug,
and as a test that fails if it comes back.

**Do not start a new handoff document.** If something must be recorded, it goes
in the chapter that owns the subject, or in `known-gaps.md`.
