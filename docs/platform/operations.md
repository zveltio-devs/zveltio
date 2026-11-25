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
| **PaaS** | `fly.toml`, `railway.json`, `render.yaml` are in the repository root. They build the Dockerfile's default target, which starts as root, runs the extension runner in the same container and drops the engine to uid 100 ([RFC](../engine/rfc-extension-runner.md), step 9b); the extensions share that container's network and memory, each process capped at 64 tasks and 1024 MB of address space. | [deployment.md](deployment.md) |

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
  One instance can run without it, declared with `ZVELTIO_SINGLE_INSTANCE=1`;
  only the newest instance then serves.
- **`CORS_ORIGINS=*` is refused.**
- **The extension auth gate cannot be disabled in production.**
- **The engine's database role must not be `SUPERUSER` or `BYPASSRLS`** in a
  multi-tenant deployment. Do not "fix" this with a blanket
  `ALTER ROLE … NOSUPERUSER` — that breaks `CREATE EXTENSION`. The correct shape
  is in [multi-tenancy.md](multi-tenancy.md) and
  `scripts/bootstrap-db-role.sh`
  provisions it.
- **Extensions want their own database roles.** The engine creates `zveltio_ext`
  (and one role per extension under it) at boot, which needs `CREATEROLE` or a
  role pre-created by `scripts/bootstrap-db-role.sh`. Without it the engine still
  boots and logs `[extensions] could not set up the zveltio_ext role`: every
  extension's `ctx.db` then runs as the tenant role `zveltio_rls`, and only the
  SQL analyzer keeps an extension out of tables it was not granted. Supported,
  but weaker; re-run the bootstrap script to restore the database-level wall.

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

**Worker extensions start on use and stop when idle** (ADR 0062 d3). An idle
one holds no memory: on a 1 vCPU / 1 GB scope with 37 worker extensions the
engine booted with no runner unit up (~150 MB PSS in all, against ~1 GB with
every unit running), each called extension added ~25-55 MB PSS while it ran,
and its idle timeout returned it to zero. Its first call after idle waits for
it: ~0.5-0.6 s on systemd under the unit's default CPU cap, ~0.13-0.25 s with
`CPUQuotaPeriodSec=1s` in the unit (ADR 0062 step 2b; a longer period also lets a
looping extension cost the engine more, see [security-model.md](security-model.md)). Per extension, an administrator chooses:

```sh
# Always on: started at boot, never stopped for idleness (latency only).
curl -X PUT https://<host>/api/marketplace/<name>/runtime \
  -H 'content-type: application/json' -d '{"alwaysOn": true}'
# Or stopped after N seconds unused (default 300).
curl -X PUT https://<host>/api/marketplace/<name>/runtime \
  -H 'content-type: application/json' -d '{"alwaysOn": false, "idleTimeoutSeconds": 900}'
```

It needs a god session stepped up for `extension.runtime:<name>` (the Studio's
marketplace Configure dialog does both), is written to `zv_settings` as
`ext_runtime:<name>`, audited as `extension.runtime_set`, and applied at once on
the replica that took it and at the next idle check on the others.
`finance/invoicing` and `operations/pos` default to always on.

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

The `1.0.0-alpha.*` track is closed; new installations use beta. Version
policy: [versioning.md](versioning.md).

---

## 8. When something is wrong

Start at [troubleshooting.md](troubleshooting.md). If the engine will not boot,
read the guard message literally — the guards name the variable and the reason,
and they run before the database precisely so that the message is about the
configuration rather than about a connection.
