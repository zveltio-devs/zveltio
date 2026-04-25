# Migrating from Zveltio Alpha to Beta (1.0.0-beta.1)

## Overview

`1.0.0-beta.1` introduces several new features, 8 new database migrations (054–061), and a handful of new environment variables. The upgrade is backward-compatible for data; existing collections and records are unaffected.

---

## New Required Environment Variables

These are required if the corresponding feature is in use:

| Variable | Required when | Description |
|----------|---------------|-------------|
| `MAIL_ENCRYPTION_KEY` | Using the `communications/mail` extension | 32-byte hex key for encrypting stored IMAP/SMTP passwords. Generate: `openssl rand -hex 32` |
| `AI_KEY_ENCRYPTION_KEY` | Using the `ai/core-ai` extension | 32-byte hex key for encrypting stored AI provider API keys. Generate: `openssl rand -hex 32` |

---

## New Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QUERY_CACHE_TTL_SECONDS` | `10` | Valkey TTL (seconds) for GET list query cache. Set to `0` to disable. |
| `FCM_SERVER_KEY` | — | Firebase Cloud Messaging legacy server key (Android + Web push) |
| `APNS_KEY` | — | ES256 private key in PEM/p8 format for APNS token-based auth |
| `APNS_KEY_ID` | — | 10-character key ID from Apple Developer console |
| `APNS_TEAM_ID` | — | 10-character Apple Developer team ID |
| `APNS_BUNDLE_ID` | — | App bundle identifier (e.g. `com.example.app`) |
| `APNS_PRODUCTION` | `false` | Set `true` to use the production APNS endpoint |
| `METRICS_TOKEN` | — | Bearer token protecting `GET /metrics`. If unset, metrics are public. |
| `TRUSTED_PROXY` | — | Set `true` to trust `X-Forwarded-For` for rate limiting identity |

---

## Database Migrations

Migrations run automatically on startup. All migrations use `IF NOT EXISTS` / `IF EXISTS` guards and are safe to re-run.

| Migration | Description |
|-----------|-------------|
| `054_preview_envs.sql` | Preview environment branch tracking |
| `055_schema_branches.sql` | Schema branch management |
| `056_request_logs.sql` | HTTP request log storage (`zv_request_logs`) |
| `057_rate_limit_configs.sql` | DB-driven rate limit configuration (`zv_rate_limit_configs`) |
| `058_performance_indexes.sql` | 7 `CONCURRENTLY` indexes on high-traffic tables |
| `059_pg_trgm.sql` | Enables `pg_trgm` extension; adds `has_trgm` flag to `zvd_collections` |
| `060_column_permissions.sql` | Column-level read/write permission rules (`zvd_column_permissions`) |
| `061_push_tokens.sql` | Mobile push notification device token storage (`zvd_push_tokens`) |

For zero-downtime upgrades:
```bash
bun run db:init
```

---

## Notable Changes

### Webhook HMAC Signing

Webhooks now auto-generate a 32-byte HMAC-SHA256 signing secret on creation. Every delivery includes an `X-Zveltio-Signature: sha256=<hex>` header.

**Action required for existing webhooks:** Existing webhooks were created without a secret. To enable signature verification, rotate the secret:

```bash
POST /api/webhooks/:id/rotate-secret
# Response: { "secret": "plaintext-shown-once", "webhook": { ... } }
```

Store the returned plaintext secret securely — it is not recoverable after this call.

### Query Result Caching

GET list responses are now cached in Valkey (`QUERY_CACHE_TTL_SECONDS`, default 10s). Cache is automatically invalidated on any write to the collection.

**If you need immediately consistent reads** (e.g. tests, admin scripts), set:
```env
QUERY_CACHE_TTL_SECONDS=0
```

### Column-Level Permissions

A new permission layer (`zvd_column_permissions`) can restrict which roles can read or write specific columns. By default, no rules are configured — all columns remain accessible to all roles with collection-level access.

**To restrict a column:**
```bash
POST /api/admin/column-permissions
{ "collection_name": "users", "column_name": "salary", "role": "employee", "can_read": false, "can_write": false }
```

Admins and god-role users always bypass column restrictions.

### Full-Text Search + pg_trgm

**New collections** (created after `059_pg_trgm.sql` runs) automatically get:
- A `search_text TEXT` column updated by trigger
- A `GIN(search_text gin_trgm_ops)` index
- Combined `?search=` matching: `websearch_to_tsquery` OR `ILIKE %term%`

**Existing collections** continue to use FTS-only (`search_vector` tsvector). No action required.

### Realtime Presence + Broadcast

New SSE subscription channels and endpoints:

```bash
# Join presence
POST /api/realtime/presence/:channel

# Broadcast to all subscribers
POST /api/realtime/broadcast/:channel

# Subscribe via SSE
GET /api/realtime/stream?channel=broadcast:chat,presence:lobby
```

### Mobile Push Notifications

When `FCM_SERVER_KEY` or `APNS_KEY` env vars are set, `sendNotification()` (server-side) automatically delivers mobile push to all registered device tokens for the target user.

Register tokens from client apps:
```bash
POST /api/notifications/push-tokens
{ "token": "<device-token>", "platform": "fcm" }
```

### Per-API-Key Rate Limits

API keys can now have individual rate limit overrides:

```bash
PUT /api/api-keys/:id/rate-limit
{ "window_ms": 60000, "max_requests": 1000 }
```

This takes precedence over the tier default for that key.

### DB-Driven Rate Limit Tiers

Rate limit tiers can be updated at runtime without a restart:

```bash
PATCH /api/admin/rate-limits/api
{ "max_requests": 500 }
# Takes effect within 60 seconds
```

---

## Upgrade Steps

1. **Pull & install**
   ```bash
   git pull
   bun install
   ```

2. **Add required env vars** (see tables above)

3. **Run database init** (applies migrations 054–061)
   ```bash
   bun run db:init
   ```

4. **Re-encrypt existing secrets** (mail + AI extensions only)
   
   After adding `MAIL_ENCRYPTION_KEY` and/or `AI_KEY_ENCRYPTION_KEY`, re-save affected IMAP/SMTP accounts and AI provider configs through the Studio to trigger encryption. Old plaintext entries will continue to work until re-saved.

5. **Rotate webhook secrets** for any existing webhooks where you want signature verification (optional but recommended).

6. **Update SDK dependencies**
   ```bash
   bun add @zveltio/sdk@1.0.0-beta.1
   bun add @zveltio/react@1.0.0-beta.1   # if using React SDK
   bun add @zveltio/vue@1.0.0-beta.1     # if using Vue SDK
   ```

---

## API Changes Summary

| New endpoint | Description |
|-------------|-------------|
| `POST /api/webhooks/:id/rotate-secret` | Rotate webhook signing secret |
| `POST /api/webhooks/:id/test` | Send synthetic test event |
| `GET /api/webhooks/:id/deliveries` | List delivery history |
| `POST /api/webhooks/:id/deliveries/:deliveryId/retry` | Force re-delivery |
| `PUT /api/api-keys/:id/rate-limit` | Set per-key rate limit |
| `DELETE /api/api-keys/:id/rate-limit` | Remove per-key rate limit |
| `POST /api/realtime/presence/:channel` | Join presence channel |
| `GET /api/realtime/presence/:channel` | List presence members |
| `DELETE /api/realtime/presence/:channel` | Leave presence channel |
| `POST /api/realtime/broadcast/:channel` | Broadcast message to channel |
| `GET /api/admin/rate-limits` | List rate limit tier configs |
| `PATCH /api/admin/rate-limits/:keyPrefix` | Update rate limit tier |
| `POST /api/admin/rate-limits/reset` | Reset tiers to defaults |
| `GET /api/admin/column-permissions` | List column permissions |
| `POST /api/admin/column-permissions` | Create/upsert column permission |
| `PUT /api/admin/column-permissions/:id` | Update column permission |
| `DELETE /api/admin/column-permissions/:id` | Delete column permission |
| `POST /api/notifications/push-tokens` | Register device push token |
| `GET /api/notifications/push-tokens` | List push tokens |
| `DELETE /api/notifications/push-tokens/:id` | Remove push token |
