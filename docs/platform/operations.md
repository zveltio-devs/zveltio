# Operations

Running Zveltio in production. This page is the operator's index; each section
links to the document that carries the detail.

---

## 1. Choosing a deployment shape

| Shape | Use when | Detail |
|---|---|---|
| **Single binary** | One organisation, one machine, up to a few hundred users. The default. | [installation.md](installation.md) |
| **Docker Compose** | You want the full stack — Postgres, PgDog, Valkey, SeaweedFS, Prometheus, Grafana — in one file. | [deployment.md](deployment.md) |
| **Kubernetes** | Multiple replicas, existing cluster, Helm-managed config. | [deployment-k8s.md](deployment-k8s.md) |
| **PaaS** | `fly.toml`, `railway.json`, `render.yaml` are in the repository root. | [deployment.md](deployment.md) |

Compiled binaries are published for linux-x64, linux-x64-baseline, linux-arm64,
macos-x64 and macos-arm64. **There is no Windows binary.**

Bare-metal and Proxmox installers are in `install/`. The Helm chart is
`charts/zveltio/`.

---

## 2. Before the first production boot

The engine refuses to start on several classes of misconfiguration, deliberately
and before it touches the database (`lib/startup-guards.ts`). Expect and respect
these:

- **`VALKEY_URL` is required.** Without a cache, the permission and identity
  caches degrade silently: `isGodUser` and `resolveUserRole` hit the database on
  every request, and a revoked grant reaches only the replica that revoked it.
  An operator who genuinely has no cache must say so with
  `ZVELTIO_ALLOW_NO_CACHE=1`.
- **`CORS_ORIGINS=*` is refused.**
- **The extension auth gate cannot be disabled in production.**
- **The engine's database role must not be `SUPERUSER` or `BYPASSRLS`** in a
  multi-tenant deployment. Do not "fix" this with a blanket
  `ALTER ROLE … NOSUPERUSER` — that breaks `CREATE EXTENSION`. The correct shape
  is in [multi-tenancy.md](multi-tenancy.md) and
  `../private/MULTI-TENANT-ENABLEMENT.md`; `scripts/bootstrap-db-role.sh`
  provisions it.

Work through the checklist in [security.md](security.md#security-checklist).

---

## 3. Sizing

The engine does **not** use a fixed default pool size. It reads the server's
`max_connections` and sizes the pool from it, falling back to
`DEFAULT_DB_POOL_MAX` only when it cannot. The ceiling it actually chose is
printed once at boot by `reportConcurrencyCeiling()` — that line is what you
size a deployment from.

Keep `pool_max × instances ≤ max_connections`. Exceeding it fails as
`sorry, too many clients already` under load, which is the failure furthest in
time from its cause.

Scaling out: [horizontal-scaling.md](horizontal-scaling.md). Measured
throughput: [benchmarks.md](benchmarks.md).

---

## 4. Observability

OpenTelemetry tracing (no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set), a
Prometheus metrics endpoint, and Grafana dashboards in `grafana/` and
`observability/`. Setup: [monitoring.md](monitoring.md).

Health checks go beyond `/api/health` — there is a health registry
(`lib/health-registry.ts`) that subsystems register into, so a degraded
dependency is visible rather than inferred.

---

## 5. Degradation

The engine is built to lose dependencies without losing correctness — with one
exception. What degrades, what fails closed, and what refuses to boot is in
[degradation.md](degradation.md). Read it before deciding that a missing service
is survivable: the cache is the case where degradation is **silent**, which is
why it is a boot requirement rather than a runtime warning.

---

## 6. Backup and recovery

[disaster-recovery.md](disaster-recovery.md) is the runbook, and it is
referenced from the product itself — `routes/backup.ts` points operators at
§3.1 in its error messages. `dr-smoke.yml` exercises the restore path in CI, and
drill records land in `docs/dr-drills/`.

A backup you have not restored is not a backup. The drill is the deliverable.

---

## 7. Upgrades

Auto-migration runs at boot under a Postgres advisory lock, so replicas do not
race. Opt out with `MIGRATIONS_AUTO=false` for deploys that control migration
explicitly.

The `upgrade-path.yml` workflow verifies that an old installation can reach the
current release. That gate matters: a migration squash once left `zveltio migrate`
reporting success while applying nothing, and the gate was correctly red for
four nights before anyone believed it.

Coming from the closed alpha track:
[migration-alpha-to-beta.md](migration-alpha-to-beta.md). Version policy:
[versioning.md](versioning.md).

---

## 8. When something is wrong

Start at [troubleshooting.md](troubleshooting.md). If the engine will not boot,
read the guard message literally — the guards name the variable and the reason,
and they run before the database precisely so that the message is about the
configuration rather than about a connection.
