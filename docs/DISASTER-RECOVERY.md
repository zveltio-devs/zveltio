# Disaster Recovery — Operator Runbook

This is the runbook for restoring a Zveltio install after data loss, host
loss, or corruption. It is written for the *operator*, not the developer:
when the alarm fires at 03:00, this is the document you read top-to-bottom.

If you only remember one thing: **a backup you have never restored is a wish,
not a backup**. Run the quarterly drill (§ 6).

---

## 1. Targets

| Tier      | Use case                                | RPO       | RTO       |
| --------- | --------------------------------------- | --------- | --------- |
| **T1**    | Single-host (dev / small prod)          | ≤ 24 h    | ≤ 2 h     |
| **T2**    | Single-host with WAL archive (PITR)     | ≤ 5 min   | ≤ 2 h     |
| **T3**    | LXC on PBS with app-consistent hook     | ≤ 5 min   | ≤ 30 min  |
| **T4**    | HA Postgres + S3 storage replication    | ≤ 1 min   | ≤ 15 min  |

- **RPO** (Recovery Point Objective): the maximum window of acceptable data
  loss. T2's "≤ 5 min" means up to 5 minutes of writes can be lost on
  catastrophic failure.
- **RTO** (Recovery Time Objective): the maximum acceptable outage. T3's
  "≤ 30 min" is from "PBS restore initiated" to "/api/health returns 200".

The defaults (`zveltio-get` install + nightly `pg_dump`) are **T1**. T2 and T3
are documented below; T4 is out of scope for v1 — track in `TECHNICAL-GAPS.md`.

---

## 2. What needs to be backed up

| Component             | Where                                    | Lost if…                          | Backup mechanism                |
| --------------------- | ---------------------------------------- | --------------------------------- | ------------------------------- |
| Postgres database     | `pg_data` (server) or managed DB         | Disk dies / DROP TABLE            | `pg_dump` + WAL archive (PITR)  |
| Valkey/Redis cache    | `appendonly.aof` / `dump.rdb`            | Process dies                      | AOF on disk; rebuildable        |
| File storage          | `STORAGE_DIR` or S3 bucket               | Filesystem corruption / bucket    | rsync / S3 versioning           |
| Engine binary         | `/usr/local/bin/zveltio`                 | rm by accident                    | Re-download from `zveltio-get`  |
| Extensions cache      | `EXTENSIONS_DIR` (default `~/.zveltio/extensions`) | Filesystem loss          | Re-install from marketplace     |
| **Secrets / keys**    | `.env`                                   | Lost forever = unrecoverable data | Encrypted offsite copy          |
| TLS certificates      | reverse proxy (caddy / nginx)            | Renewal failure                   | Backup proxy config             |

> ⚠️  **Lose `BETTER_AUTH_SECRET` and you lose every existing session token.
> Lose `FIELD_ENCRYPTION_KEY` and any encrypted field becomes unreadable
> ciphertext — no recovery is possible.** Keep these in an offline keystore
> (1Password, vault, sealed envelope), not in the same backup blob as the DB.

---

## 3. Backup procedures

### 3.1 T1 — Nightly logical dump (default)

Built-in. Triggered via `POST /api/backup` or the Studio "Backups" page; runs
`pg_dump | gzip` to `BACKUP_DIR` (default `/tmp/zveltio-backups`). Retains 20
backups. Schedule daily via `cron`:

```sh
# /etc/cron.d/zveltio-backup
0 3 * * * root curl -s -X POST -H "Authorization: Bearer $ZV_ADMIN_TOKEN" \
  http://localhost:3000/api/backup -d '{"notes":"nightly"}'
```

Verify weekly that files exist, are non-zero, and decompress cleanly:

```sh
for f in /var/backups/zveltio/*.sql.gz; do
  gzip -t "$f" || echo "CORRUPT: $f"
done
```

### 3.2 T2 — Point-in-time recovery (PITR)

Requires Postgres WAL archiving. Configure once in `postgresql.conf`:

```conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /var/lib/postgresql/wal-archive/%f && cp %p /var/lib/postgresql/wal-archive/%f'
archive_timeout = 300       # force segment switch every 5 min → RPO cap
```

Then take a base backup weekly:

```sh
pg_basebackup -D /var/backups/zveltio/base-$(date +%F) -F t -X stream -z -P
```

Register the WAL archive path in Zveltio so Studio's "PITR" tab can list
restorable timestamps:

```sh
curl -X PATCH -H "Authorization: Bearer $ZV_ADMIN_TOKEN" \
  http://localhost:3000/api/backup/pitr/config \
  -d '{"is_enabled":true,"wal_archive_path":"/var/lib/postgresql/wal-archive","retention_days":14}'
```

### 3.3 T3 — Proxmox Backup Server (LXC + app-consistent hook)

For Zveltio installs deployed via `zveltio-get` into an LXC container, install
the pre-backup hook so PBS captures an application-consistent snapshot:

```sh
cp zveltio-get/pbs-hooks/pre-backup.sh /etc/proxmox-backup/pre-backup.d/zveltio-checkpoint.sh
chmod +x /etc/proxmox-backup/pre-backup.d/zveltio-checkpoint.sh
```

The hook flushes WAL (`CHECKPOINT`), persists Valkey (`BGSAVE`), and `sync`s
the filesystem before PBS takes the snapshot. Without it the snapshot is
*crash*-consistent (Postgres can recover but you may lose ≤ `checkpoint_timeout`
of writes).

---

## 4. Restore procedures

Each scenario assumes the operator is on the target host and has shell
access. Replace `$ZVELTIO_DB`, `$ZVELTIO_USER`, etc. with your values.

### Scenario A — Engine binary lost (no data loss)

```sh
curl -sSL https://zveltio.com/install.sh | bash
systemctl restart zveltio
```

The engine is stateless; reinstalling restores `/api/health` in < 30 s.

### Scenario B — Restore from `pg_dump` (T1)

```sh
systemctl stop zveltio
gunzip -c backup-2026-05-18T03-00-00Z.sql.gz | psql -U "$ZVELTIO_USER" -d "$ZVELTIO_DB"
systemctl start zveltio
curl -sf http://localhost:3000/api/health || { echo "engine unhealthy"; exit 1; }
```

Smoke-check (§ 5) before declaring complete.

### Scenario C — PITR to a specific timestamp (T2)

1. Stop the engine: `systemctl stop zveltio`
2. Stop Postgres: `systemctl stop postgresql`
3. Move corrupt cluster aside: `mv $PGDATA $PGDATA.corrupt`
4. Untar base backup: `tar xzf base-2026-05-15.tar.gz -C $PGDATA`
5. Create `$PGDATA/recovery.signal` and add to `postgresql.conf`:
   ```conf
   restore_command = 'cp /var/lib/postgresql/wal-archive/%f %p'
   recovery_target_time = '2026-05-18 03:14:00 UTC'
   ```
6. Start Postgres — it replays WAL up to the target.
7. After "consistent recovery state reached", promote: `pg_ctl promote`
8. Start the engine, run smoke tests (§ 5).

### Scenario D — Restore LXC from PBS (T3)

In the Proxmox UI: select the snapshot → Restore → new VMID.
After boot, network up:

```sh
# Inside the restored container
systemctl status zveltio postgres valkey   # all should be running
curl -sf http://localhost:3000/api/health
```

If extensions show as "broken" in Studio, re-trigger activation:

```sh
curl -X POST -H "Authorization: Bearer $ZV_ADMIN_TOKEN" \
  http://localhost:3000/api/admin/extensions/reactivate-all
```

### Scenario E — File storage lost

Local storage (`STORAGE_DIR`): restore from rsync mirror or PBS snapshot
(included by default in T3).

S3 storage: enable versioning + replication on the bucket *before* the
incident. After the incident, list and recover deleted objects with
`aws s3api list-object-versions`. Zveltio's `zv_media` table contains the
canonical filename → record mapping; if the bucket is restored verbatim,
no DB changes are needed.

### Scenario F — Lost encryption keys

There is no recovery path. If `FIELD_ENCRYPTION_KEY` is lost:

1. The DB is intact but encrypted columns are unreadable ciphertext.
2. New writes work, but old encrypted data is gone.
3. File a post-mortem; review key-storage policy.

`BETTER_AUTH_SECRET` loss invalidates sessions but data is intact — users
re-sign-in. API keys hashed with the old secret become unverifiable; rotate
them via Studio's "API Keys" page after restoring access via admin password.

---

## 5. Smoke checks after any restore

Before declaring an outage resolved, verify in this order:

```sh
# 1. Engine reports healthy
curl -sf http://localhost:3000/api/health | jq .status   # → "ok"

# 2. Database connectivity + row count sanity
psql -U "$ZVELTIO_USER" -d "$ZVELTIO_DB" -c "SELECT count(*) FROM zvd_collections;"

# 3. Admin can sign in
curl -sf -X POST http://localhost:3000/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"…"}' | jq .token

# 4. At least one extension activates
curl -sf -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/admin/extensions | jq '.[].status' | grep -q active

# 5. Realtime: open Studio, create+update a record, see the event
```

If any of these fails, do NOT mark the restore complete. Roll back to the
last known-good snapshot and root-cause before retrying.

---

## 6. Quarterly drill

We run this checklist every 90 days against a non-prod environment, and the
result is logged in `docs/dr-drills/<date>.md`.

- [ ] Spin up a fresh LXC from the most recent PBS snapshot
- [ ] Run § 5 smoke checks against the restored host
- [ ] Restore a single `pg_dump` from § 3.1 onto a scratch DB
- [ ] Perform a PITR (§ 3.2) to a known-good timestamp; verify a row that
      existed at T-30min is present and a row from T-10min is absent
- [ ] Rotate `BETTER_AUTH_SECRET` and verify only-old-token-invalidation
- [ ] Time each scenario end-to-end; record against RPO/RTO targets in § 1

A scripted helper for the first three steps lives at
`scripts/dr-drill.sh` — see § 7.

---

## 7. Drill automation

The script `scripts/dr-drill.sh` automates the parts that can be automated.
It expects a fresh test host with `bun`, `psql`, and `pg_dump` installed,
and refuses to run if `$ZVELTIO_ENV != "drill"` to prevent operator error.

Output is a markdown report at `docs/dr-drills/drill-<timestamp>.md` with
pass/fail per scenario and measured wall-clock times.

---

## 8. Failure modes seen in the wild

This section will grow as we run drills and real incidents. Each entry:
what failed, root cause, fix, prevention.

(Empty until first incident or drill — write entries here, not as scattered
post-mortems.)
