---
"@zveltio/sdk": patch
---

v1.0 ship-readiness pack

**Performance**
- New benchmark suite at `bench/` — REST CRUD, list+pagination, realtime WS,
  cold-start. Pocketbase comparison via docker-compose. CI `perf-smoke` job
  enforces p95 budgets on every PR.

**Reliability**
- Disaster recovery runbook at `docs/DISASTER-RECOVERY.md` with operator
  scenarios A–F and quarterly drill automation (`scripts/dr-drill.sh`).
- Deep health checks: `GET /api/health/ready` (k8s readiness probe) and
  `GET /api/health/deep` (per-check operator diagnostic with timings).
- Observability stack at `observability/` — Prometheus + Grafana
  docker-compose, pre-wired engine overview dashboard.

**Security**
- Audit coverage went from 7% to 22% on mutating routes. New events:
  `backup.*`, `pitr.*`, `approval.*`, `export.executed`.
- `scripts/audit-regression-check.ts` locks 28 critical-path handlers
  into CI. PRs that drop an `auditLog()` call on a mandatory route fail
  the build.

**Features that ship to market**
- **Five pre-built business templates** — CRM, Invoicing, Project Mgmt,
  Help Desk, Asset Inventory. One-click install via `/admin/templates`,
  engine route `POST /api/templates/:id/install` creates collections in
  dependency order.
- **Visual schema designer** at `/admin/collections/erd`. Drag-to-arrange
  with per-user server-side persistence (table `zv_erd_layouts` + route
  `/api/erd/layout`, localStorage fallback). Force-directed auto-arrange
  (Fruchterman–Reingold). Export to PNG (@2×) + SVG. Inline editing on
  every card: double-click renames, pencil opens type/required popover.
  `PATCH /api/collections/:name/fields/:field` accepts rename + type
  change + required toggle in one atomic call. Field-type conversion
  matrix in `packages/engine/src/lib/field-type-conversions.ts`.
- **Public demo mode** — `DEMO_MODE=true` env flag. Engine middleware
  blocks destructive admin ops (HTTP 451), Studio shows persistent
  banner, login page surfaces credentials. Reproducible deploy via
  `demo/docker-compose.yml` + `demo/seed.sh` + `demo/reset.sh` cron.

**Community + go-to-market**
- `CONTRIBUTING.md`, GitHub issue + discussion templates.
- Website: `/support` (Community / Indie / Business / Enterprise tiers)
  and `/demo` pages.

**Migrations**
- `076_erd_layout.sql` — per-user ERD positions.

**Breaking changes**
- None. All new endpoints + flags are additive.
