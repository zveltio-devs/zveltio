# Deploying Zveltio on Kubernetes

This guide walks through installing the engine on K8s via the official Helm chart in [`charts/zveltio`](../charts/zveltio).

The chart ships **only the engine**. Postgres, Valkey, and S3-compatible storage are external by default — most production deployments use managed services for these (Cloud SQL / RDS / Aiven / Supabase Postgres, ElastiCache / Memorystore / Aiven Valkey, S3 / R2 / MinIO). For dev / staging, in-cluster Postgres + Valkey are available behind feature flags.

## Quick start (single-node, dev)

```bash
# 1. Add the chart locally
cd charts/zveltio

# 2. Generate the required secrets
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -base64 32)
MAIL_ENCRYPTION_KEY=$(openssl rand -base64 32)
AI_KEY_ENCRYPTION_KEY=$(openssl rand -base64 32)

# 3. Install
helm install zveltio . \
  --namespace zveltio --create-namespace \
  --set postgresql.enabled=true \
  --set engine.config.betterAuthSecret="$BETTER_AUTH_SECRET" \
  --set engine.config.betterAuthUrl="http://localhost:3000" \
  --set engine.config.encryptionKey="$ENCRYPTION_KEY" \
  --set engine.config.mailEncryptionKey="$MAIL_ENCRYPTION_KEY" \
  --set engine.config.aiKeyEncryptionKey="$AI_KEY_ENCRYPTION_KEY"

# 4. Wait for the engine to be ready
kubectl rollout status deploy/zveltio-engine -n zveltio --timeout=120s

# 5. Open the admin UI
kubectl port-forward svc/zveltio-engine 3000:3000 -n zveltio
#   then: http://localhost:3000/admin

# 6. Create the first super-admin
kubectl exec -it deploy/zveltio-engine -n zveltio -- zveltio create-god
```

## Production

For production, set values via a `values-prod.yaml` file:

```yaml
# values-prod.yaml
engine:
  replicaCount: 3
  image:
    tag: "v1.0.0"  # pin a release, never "latest"
  resources:
    limits:   { cpu: 4000m, memory: 2Gi }
    requests: { cpu: 500m, memory: 512Mi }
  existingSecret: zveltio-prod-env   # see "Secret management" below
  config:
    # databaseUrl, encryptionKey, etc. live in the existingSecret;
    # only non-sensitive overrides go here.
    betterAuthUrl: https://zveltio.example.com
    valkeyUrl: ""  # leave empty if filled by existingSecret
    s3:
      endpoint: https://s3.example.com
      bucket: zveltio-uploads
      region: auto

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
  hosts:
    - host: zveltio.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: zveltio-tls
      hosts: [zveltio.example.com]

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 20
  targetCPUUtilizationPercentage: 75

podDisruptionBudget:
  enabled: true
  minAvailable: 2

persistence:
  enabled: true
  storageClass: gp3
  size: 50Gi

migrationJob:
  enabled: true  # blue/green deploys benefit from explicit pre-deploy migrate
```

Then:

```bash
helm upgrade --install zveltio ./charts/zveltio \
  -n zveltio --create-namespace \
  -f values-prod.yaml
```

## Secret management

The chart's `engine.config.*` fields can hold secrets inline — fine for local dev. For production, set `engine.existingSecret: <name>` to reuse a Secret managed externally. The chart reads `envFrom: secretRef` so every key in the Secret becomes an engine env var.

Expected keys in the existing Secret:

| Key | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://...` |
| `NATIVE_DATABASE_URL` | when behind PgBouncer | Bypasses pooler for LISTEN/NOTIFY |
| `VALKEY_URL` | recommended when replicas ≥ 3 | `redis://...` |
| `BETTER_AUTH_SECRET` | yes | 32+ random chars |
| `BETTER_AUTH_URL` | yes | Public base URL |
| `ENCRYPTION_KEY` | yes | AES-256-GCM master key |
| `MAIL_ENCRYPTION_KEY` | when SMTP configured | |
| `AI_KEY_ENCRYPTION_KEY` | when AI extension active | |
| `METRICS_TOKEN` | recommended | Bearer for `/metrics` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional | OpenTelemetry collector |
| `S3_*` | when using S3 storage | endpoint / bucket / region / keys |
| `REGISTRY_PUBLIC_KEYS_JSON` | when verifying signed extensions | See `docs/EXTENSION-DEVELOPER-GUIDE.md` |

**External Secrets Operator** + Vault / AWS Secrets Manager / GCP Secret Manager is the recommended pattern. Sealed-secrets works too if you prefer GitOps.

## Realtime + horizontal scaling

The engine supports two cross-instance realtime backends (S5-03):

- **Valkey PUB/SUB** (preferred for ≥3 replicas) — set `engine.config.valkeyUrl` or `redis.enabled: true`.
- **Postgres LISTEN/NOTIFY** (default fallback) — works with any deployment that has `DATABASE_URL`, no extra services needed.

The bus picks one automatically based on env. Both filter self-echo via a per-pod origin id so WS clients on the originating replica don't receive duplicate events.

## Schema migrations

Two patterns, controlled by `engine.config.migrationsAuto` and `migrationJob.enabled`:

| Setting | Behavior |
|---|---|
| `migrationsAuto: "true"` (default) + `migrationJob.enabled: false` | Engine pod applies pending migrations on startup under a `pg_advisory_lock`. Multiple replicas race; only one applies. |
| `migrationsAuto: "false"` + `migrationJob.enabled: true` | Helm runs a pre-install/pre-upgrade Job (`bun run migrate`) that applies migrations before any new engine pod starts. Blue/green-friendly. |
| Both true | Job runs first, engines find nothing to migrate. Redundant but safe. |
| Both false | You manage migrations manually with `zveltio migrate`. CI / explicit-control deploys only. |

## Persistence

The engine writes downloaded extension archives, unpacked extension code, and (when S3 is not configured) uploads under `/data` in the container. The chart creates a PVC by default (`persistence.enabled: true`).

For fully stateless deployments (S3 for uploads + read-only extension marketplace), set `persistence.enabled: false`.

## Probes

Three health endpoints, each with a specific role:

| Endpoint | Auth | Use for | Behaviour |
|---|---|---|---|
| `GET /api/health` | none | liveness | Returns 200 only if the engine process is responsive. No DB, no cache. ~0.5 ms typical. |
| `GET /api/health/ready` | none | readiness | Returns 200 if the engine has finished boot (migrations applied, extensions loaded). 503 during startup. |
| `GET /api/health/deep` | auth | manual checks + alarms | Probes DB, cache, backup dir, storage dir. Returns 503 if any check fails. ~10-50 ms typical. NOT for kubelet probes — auth-gated. |

Recommended Kubernetes probes:

```yaml
livenessProbe:
  httpGet:
    path: /api/health
    port: 3000
  initialDelaySeconds: 30
  # On a healthy engine /health returns in <1 ms; 5 s gives
  # plenty of room before kubelet declares the pod stuck.
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3      # restart after 30 s of failures
  successThreshold: 1

readinessProbe:
  httpGet:
    path: /api/health/ready
    port: 3000
  # Engine boot includes pending migrations + extension loading;
  # cold start is 2-3 s, slow on first deploy with many extensions.
  initialDelaySeconds: 5
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3      # 15 s before traffic is removed
  successThreshold: 1

startupProbe:
  # Optional but recommended for slow-starting deployments
  # (lots of extensions, slow DB during migration). Once it
  # passes, liveness+readiness take over.
  httpGet:
    path: /api/health/ready
    port: 3000
  periodSeconds: 5
  failureThreshold: 30     # tolerate up to 150 s for first boot
```

`/api/health` deliberately returns minimal info (no engine version,
no schema version) per the security-sprint policy. Use
`/api/version` (auth-gated) for richer details, and
`/api/health/deep` (also auth-gated) for production alarms on
downstream-dependency failures.

## Observability

- Prometheus scrape target: `GET /metrics` with `Authorization: Bearer $METRICS_TOKEN`.
- OpenTelemetry: set `OTEL_EXPORTER_OTLP_ENDPOINT` to your collector.
- Logs: stdout. Use Loki, CloudWatch, or your platform's default.

## Uninstall

```bash
helm uninstall zveltio -n zveltio
```

The chart's PVCs (engine data + Postgres data when enabled) are NOT deleted by `helm uninstall` — they're retained to prevent accidental data loss. Delete them explicitly:

```bash
kubectl delete pvc -l app.kubernetes.io/instance=zveltio -n zveltio
```

## Chart development

Lint locally before submitting a chart PR:

```bash
helm lint ./charts/zveltio
helm template test ./charts/zveltio --debug | kubectl apply --dry-run=client -f -
```

Render with a values override to check specific scenarios:

```bash
# Production-style with HPA + ingress
helm template zveltio ./charts/zveltio -f values-prod.yaml

# Dev-style with in-cluster Postgres
helm template zveltio ./charts/zveltio --set postgresql.enabled=true
```
