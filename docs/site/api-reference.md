# API Reference

Complete REST API reference for Zveltio Engine. All endpoints are prefixed with `/api` and require authentication unless otherwise noted.

## Authentication

Zveltio uses [Better-Auth](https://better-auth.com) for session management via HTTP-only cookies. Include `credentials: 'include'` in all fetch calls from the browser.

For server-to-server requests, use an **API key** via the `X-API-Key` header or `Authorization: Bearer`:

```
X-API-Key: zvk_a1b2c3d4e5f6...
Authorization: Bearer zvk_a1b2c3d4e5f6...
```

API keys are created via `POST /api/api-keys` and start with the `zvk_` prefix. They are HMAC-SHA256 hashed before storage — the raw key is shown only once at creation.

### POST /api/auth/sign-up/email

Register a new user with email and password.

**Request body:**

| Field      | Type   | Description                       |
| ---------- | ------ | --------------------------------- |
| `email`    | string | User email address _(required)_   |
| `password` | string | Minimum 8 characters _(required)_ |
| `name`     | string | Display name _(optional)_         |

```json
// Request
{
  "email": "user@example.com",
  "password": "securepassword123",
  "name": "John Doe"
}

// Response
{
  "user": {
    "id": "usr_...",
    "email": "user@example.com",
    "name": "John Doe"
  }
}
```

### POST /api/auth/sign-in/email

Sign in with email and password. Sets a session cookie.

```json
// Request
{
  "email": "user@example.com",
  "password": "securepassword123"
}
```

### POST /api/auth/sign-out

Invalidate the current session.

---

## Collections

Dynamic collections allow you to create database tables at runtime without writing SQL or migrations.

### GET /api/collections

List all collections.

```json
// Response
{
  "collections": [
    {
      "id": "col_abc123",
      "name": "products",
      "fields": [...],
      "created_at": "2026-01-01T00:00:00Z"
    }
  ]
}
```

### POST /api/collections

Create a new collection. Returns `202 Accepted` with a `job_id` — table creation is async.

| Field    | Type   | Description                                  |
| -------- | ------ | -------------------------------------------- |
| `name`   | string | Collection name in `snake_case` _(required)_ |
| `fields` | array  | Array of field definitions _(required)_      |

```json
// Request
{
  "name": "products",
  "fields": [
    { "name": "title", "type": "text", "required": true },
    { "name": "price", "type": "number", "required": true },
    { "name": "description", "type": "richtext" }
  ]
}

// Response
{
  "job_id": "ddl_xyz",
  "status": "queued"
}
```

### GET /api/collections/:name

Get a single collection schema.

### PATCH /api/collections/:name

Update collection metadata or add fields.

### DELETE /api/collections/:name

Delete a collection and its data.

---

## Data CRUD

### GET /api/data/:collection

List records with filtering and pagination.

**Query parameters:**

| Parameter | Type   | Description                                               |
| --------- | ------ | --------------------------------------------------------- |
| `page`    | number | Page number for offset pagination (default: `1`)          |
| `limit`   | number | Records per page, max 500 (default: `20`)                 |
| `sort`    | string | Sort field name (default: `created_at`)                   |
| `order`   | string | `asc` or `desc` (default: `desc`)                         |
| `filter`  | string | JSON filter expression                                    |
| `search`  | string | Full-text search. Uses PostgreSQL `websearch_to_tsquery` on the `search_vector` tsvector column. For collections created after pg_trgm is enabled, also performs fuzzy `ILIKE` matching — useful for short terms, prefixes, and non-English content. |
| `cursor`  | string | Base64url cursor for keyset pagination (see below)        |
| `as_of`   | string | ISO 8601 timestamp for Time Travel queries                |

**Response:**

```json
{
  "data": [...],
  "total": 100,
  "page": 1,
  "limit": 20,
  "pages": 5,
  "next_cursor": "eyJpZCI6InJlY18xMjMiLCJ2YWwiOiIyMDI2LTAxLTAxIn0"
}
```

**Cache headers:** All GET responses include `ETag`, `Cache-Control: private, max-age=0, must-revalidate`, and `Vary: Cookie, X-API-Key, Authorization`. Send `If-None-Match: <etag>` to get a `304 Not Modified` response when data hasn't changed.

#### Cursor-based pagination

For large datasets, use cursor pagination instead of `page` offset — it is O(1) at any depth:

```
GET /api/data/products?limit=20
→ response includes next_cursor: "eyJpZCI6..."

GET /api/data/products?cursor=eyJpZCI6...&limit=20
→ next page, no duplicate records
```

Pass `cursor` instead of `page`. Both can coexist — if `cursor` is set and `page=1` (default), cursor mode is used.

#### Filter syntax

Two formats are supported — use whichever is more convenient:

**JSON format** (all operators, full control):
```
GET /api/data/products?filter={"price":{"gt":100},"category":"electronics"}
```

**Bracket format** (simpler for curl/browser):
```
GET /api/data/products?price[gt]=100&category[eq]=electronics
```

Both formats can be combined — JSON takes precedence for the same field.

Supported operators: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `like`, `ilike`, `in`, `not_in`, `null`, `not_null`.

### POST /api/data/:collection

Create a new record.

```json
// Request
{
  "title": "iPhone 15 Pro",
  "price": 999,
  "category": "electronics"
}

// Response
{
  "record": {
    "id": "rec_xyz789",
    "title": "iPhone 15 Pro",
    "price": 999,
    "created_at": "2026-01-01T12:00:00Z"
  }
}
```

### GET /api/data/:collection/:id

Get a single record by ID. Supports `?as_of=<ISO8601>` for historical data.

### PATCH /api/data/:collection/:id

Partially update a record (only provided fields are changed).

### PUT /api/data/:collection/:id

Replace a record entirely.

### DELETE /api/data/:collection/:id

Soft-delete a record (sets `deleted_at`).

### GET /api/data/:collection/:id/timeline

Return the revision history for a single record.

---

## Bulk Operations

All bulk endpoints operate within a single database transaction. Up to **500 records** per request. On partial errors the response is `207 Multi-Status` with per-record error details.

### POST /api/data/:collection/bulk

Insert multiple records.

```json
// Request
{
  "records": [
    { "title": "Product A", "price": 10 },
    { "title": "Product B", "price": 20 }
  ]
}

// Response 201 (or 207 on partial errors)
{
  "created": 2,
  "records": [ { "id": "...", "title": "Product A", ... }, ... ],
  "errors": []
}
```

### PATCH /api/data/:collection/bulk

Partially update multiple records. Each entry must include `id`.

```json
// Request
{
  "records": [
    { "id": "uuid-1", "price": 15 },
    { "id": "uuid-2", "status": "published" }
  ]
}

// Response 200
{
  "updated": 2,
  "records": [ ... ],
  "errors": []
}
```

### DELETE /api/data/:collection/bulk

Delete multiple records by ID.

```json
// Request
{ "ids": ["uuid-1", "uuid-2", "uuid-3"] }

// Response 200
{ "deleted": 3, "ids": ["uuid-1", "uuid-2", "uuid-3"] }
```

---

## RPC — Database Functions

Call a whitelisted PostgreSQL function directly from the API. Equivalent to `supabase.rpc('function', { args })`.

Functions must be registered in Studio → RPC Functions (or via `/api/rpc/` admin endpoints) before they can be called.

### POST /api/rpc/:function

```bash
# Call a function with named arguments
POST /api/rpc/get_user_stats
Content-Type: application/json
{ "user_id": "uuid-123", "period": "monthly" }

# Response
{ "data": [ { "total_orders": 42, "revenue": 1200.50 } ] }
```

Arguments are passed as named parameters — order doesn't matter. Call with no body to invoke a function with no arguments.

### Admin: manage function whitelist

```bash
# List registered functions
GET /api/rpc/

# Register a function
POST /api/rpc/
{
  "function_name": "get_user_stats",
  "description": "Returns aggregated stats for a user",
  "required_role": "member",  // minimum role to call
  "is_enabled": true
}

# Remove from whitelist
DELETE /api/rpc/:id
```

---

## Storage

### POST /api/storage/presign

Get a presigned URL for direct upload to S3-compatible storage.

```json
// Request
{
  "filename": "document.pdf",
  "contentType": "application/pdf"
}

// Response
{
  "uploadUrl": "https://...",
  "fileId": "file_xyz",
  "publicUrl": "https://..."
}
```

### GET /api/storage

List files in storage.

### DELETE /api/storage/:id

Delete a file.

---

## Permissions

Zveltio uses **Casbin** for authorization. Policies grant a `subject` (user ID or role name) access to a `resource` (collection name or system resource) with a specific `action`.

### GET /api/permissions

List all Casbin policies.

### POST /api/permissions/policies

Add a policy.

```json
// Request
{
  "subject": "user-uuid-or-role-name",
  "resource": "products",
  "action": "read"
}
// Actions: read | create | update | delete | *
// System resources: admin | storage | approvals
// Collection resources: use the collection name directly (e.g. "products")
```

### DELETE /api/permissions/policies

Remove a policy (same body as POST).

### GET /api/permissions/roles/:userId

Get all Casbin roles assigned to a user.

### POST /api/permissions/roles

Assign a Casbin role to a user.

```json
{ "userId": "user-uuid", "role": "manager" }
```

### DELETE /api/permissions/roles

Remove a Casbin role from a user.

### POST /api/permissions/cache/invalidate

Force-invalidate the in-memory permission cache.

### POST /api/permissions/bootstrap

**Emergency recovery endpoint.** Promotes a user to `god` role when you are locked out of the system. Requires the `RECOVERY_TOKEN` environment variable to be set (min 32 chars).

```bash
curl -X POST /api/permissions/bootstrap \
  -H "Authorization: Bearer <RECOVERY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@yourapp.com"}'
```

---

## AI

### POST /api/ai/chat

Send a chat message to the AI assistant.

```json
// Request
{
  "message": "What are the top selling products?",
  "context": { "collection": "products" }
}

// Response
{
  "response": "Based on your sales data...",
  "sources": ["products table"]
}
```

### POST /api/ai/search

Perform semantic search using vector embeddings.

```json
// Request
{
  "query": "How to reset password",
  "collection": "articles",
  "limit": 5
}

// Response
{
  "results": [
    {
      "id": "rec_123",
      "title": "Password Reset Guide",
      "score": 0.95
    }
  ]
}
```

### POST /api/ai/embed

Generate a vector embedding for a single text.

```json
// Request
{ "text": "The quick brown fox" }

// Response
{ "embedding": [0.123, -0.456, 0.789, ...] }
```

### GET /api/ai/providers

List configured AI providers.

### POST /api/ai/schema/generate

Generate a collection schema from a natural language description.

```json
// Request
{
  "prompt": "A CRM with contacts, companies and deals",
  "apply": false
}

// Response
{
  "collections": [...],
  "sql_preview": "CREATE TABLE contacts ..."
}
```

---

## Realtime

### GET /api/realtime/stream

Server-Sent Events (SSE) stream for real-time data updates.

**Authentication:** Session cookie (SSE clients can't send custom headers, so API keys are not supported on this endpoint).

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `collection` | Comma-separated collection names to subscribe to. Omit for all collections. |
| `channel` | Comma-separated custom channels: `broadcast:name`, `presence:name`. |
| `record_id` | Subscribe only to events for this specific record UUID. |
| `filter` | JSON filter object — only events whose record matches are forwarded. |

**Examples:**

```bash
# Subscribe to all events on the orders collection
GET /api/realtime/stream?collection=orders

# Subscribe only to changes on a specific record
GET /api/realtime/stream?collection=orders&record_id=uuid-123

# Subscribe to orders where status = "processing"
GET /api/realtime/stream?collection=orders&filter={"status":"processing"}

# Subscribe to a custom broadcast channel
GET /api/realtime/stream?channel=broadcast:chat-room-1

# Subscribe to data changes + presence events simultaneously
GET /api/realtime/stream?collection=documents&channel=presence:documents
```

**Filter operators in subscriptions:** `eq`, `neq`, `in`.

**Event format:**

```json
{
  "channel": "zveltio:data:orders",
  "event": "insert",
  "collection": "orders",
  "data": { "id": "...", "status": "new", ... },
  "timestamp": "2026-04-21T12:00:00.000Z"
}
```

Events: `insert`, `update`, `delete`.

**JavaScript client:**

```javascript
const es = new EventSource('/api/realtime/stream?collection=orders&filter={"status":"processing"}', {
  withCredentials: true,
});
es.addEventListener('data', (e) => {
  const { event, data } = JSON.parse(e.data);
  console.log(event, data); // "insert", { id: "...", ... }
});
```

### Presence Channels

Track which users are currently active in a channel. Backed by Valkey sorted sets with 60-second TTL; falls back to in-memory when Valkey is unavailable.

```bash
# Join a presence channel (or send heartbeat — repeat every ~30s)
POST /api/realtime/presence/:channel
Content-Type: application/json
{ "cursor": "editing-line-42" }   # optional metadata

# List current members
GET /api/realtime/presence/:channel
# Response: { "channel": "documents", "members": [{ "userId": "...", "lastSeen": 1714000000000 }] }

# Leave a presence channel
DELETE /api/realtime/presence/:channel
```

Clients subscribed to the SSE stream with `?channel=presence:documents` receive `presence.join` and `presence.leave` events in real time.

### Broadcast Channels

Publish arbitrary messages to named channels. Any authenticated user can publish; subscribers receive events via the SSE stream.

```bash
# Publish a message
POST /api/realtime/broadcast/:channel
Content-Type: application/json
{
  "event": "cursor-moved",
  "payload": { "x": 120, "y": 45, "userId": "user-abc" }
}

# Subscribe (SSE)
GET /api/realtime/stream?channel=broadcast:my-channel
```

Useful for collaborative editing, live dashboards, or any user-to-user event bus.

---

## Webhooks

### GET /api/webhooks

List all configured webhooks (secrets are masked).

### POST /api/webhooks

Create a new webhook. A 32-byte HMAC signing secret is **auto-generated** if you don't provide one. The raw secret is returned **only once** in the response body (`_secret_shown_once: true`).

```json
// Request
{
  "name": "Order Notifications",
  "url": "https://your-service.com/hooks/zveltio",
  "events": ["insert", "update"],
  "collections": ["orders"]
}

// Response 201 — save the secret now, subsequent GETs return ••••••••
{
  "webhook": { "id": "...", "name": "Order Notifications", "secret": "a3f9c2..." },
  "_secret_shown_once": true
}
```

### POST /api/webhooks/:id/rotate-secret

Generate a new signing secret for a webhook. Returns the new plaintext secret — update your receiver immediately, as the old secret is invalidated.

```json
// Response
{
  "secret": "b7d1e4...",
  "webhook": { "id": "...", "secret": "••••••••" }
}
```

### POST /api/webhooks/:id/test

Send a synthetic `event: "test"` payload to verify your endpoint is reachable (includes signature header).

### GET /api/webhooks/:id/deliveries

Get delivery log for a webhook.

### POST /api/webhooks/:id/deliveries/:deliveryId/retry

Retry a failed delivery.

---

## Export

### POST /api/export/:collection

Export collection data to PDF, Excel, or CSV.

```json
// Request
{
  "format": "pdf",
  "filters": { "category": "electronics" },
  "template": "professional"
}
// Response: file download (binary)
```

---

## Translations

### GET /api/translations/:key

Get translation for a key in all languages.

### POST /api/translations

Create or update a translation entry.

```json
{
  "key": "welcome_message",
  "locale": "ro",
  "value": "Bun venit!"
}
```

---

## API Keys

### GET /api/api-keys

List all API keys (admin only). Raw keys are never returned — only prefix and metadata.

### POST /api/api-keys

Create an API key. The raw key is returned **only once** in the response.

```json
// Request
{
  "name": "Mobile App",
  "scopes": [
    { "collection": "products", "actions": ["read"] },
    { "collection": "orders", "actions": ["read", "create"] }
  ],
  "rate_limit": 1000,
  "expires_at": "2027-01-01T00:00:00Z"
}

// Response — save the key, it won't be shown again
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Mobile App",
  "key": "zvk_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "key_prefix": "zvk_a1b2c3",
  "scopes": [...],
  "created_at": "2026-01-01T00:00:00Z"
}
```

### PUT /api/api-keys/:id/rate-limit

Set a custom rate limit for a specific API key, overriding the tier defaults.

```json
// Request
{
  "window_ms": 60000,
  "max_requests": 500
}
// Response
{ "success": true, "key_prefix": "apikey:<uuid>", "window_ms": 60000, "max_requests": 500 }
```

### DELETE /api/api-keys/:id/rate-limit

Remove the per-key override, reverting to the tier default.

### DELETE /api/api-keys/:id

Revoke an API key immediately.

---

## Column Permissions

Restrict which fields a role can read or write on a per-collection basis.

> All `/api/admin/column-permissions` endpoints require admin role.

```bash
# List all rules (optionally filtered by collection)
GET /api/admin/column-permissions?collection=orders

# Create or update a rule
POST /api/admin/column-permissions
{
  "collection_name": "orders",
  "column_name": "internal_cost",
  "role": "viewer",
  "can_read": false,
  "can_write": false
}
# Use column_name: "*" to apply to all columns in the collection.

# Update a rule
PUT /api/admin/column-permissions/:id
{ "can_read": true, "can_write": false }

# Delete a rule
DELETE /api/admin/column-permissions/:id
```

At runtime, `GET /api/data/:collection` and `GET /api/data/:collection/:id` strip hidden fields. `POST` and `PATCH` return `403` if the payload includes a read-only field.

---

## Push Notifications

Register device tokens and deliver mobile push notifications to users (FCM for Android/Web, APNS for iOS). Requires `FCM_SERVER_KEY` and/or `APNS_KEY` env vars.

```bash
# Register a device token (call after login or token refresh)
POST /api/notifications/push-tokens
{
  "token": "ExponentPushToken[...]",
  "platform": "fcm",        # "fcm" | "apns" | "web"
  "device_name": "iPhone 15"
}

# List own registered tokens
GET /api/notifications/push-tokens
# Response: { "tokens": [{ "id": "...", "platform": "fcm", "device_name": "..." }] }

# Unregister a token (on logout or token rotation)
DELETE /api/notifications/push-tokens/:id
```

Push notifications are sent automatically alongside in-app notifications whenever `sendNotification()` is called internally (flows, admin broadcast, etc.), provided at least one token is registered for the target user.

---

## Admin

> All `/api/admin/*` endpoints require admin role.

### GET /api/admin/status

Full system status including DB, cache, memory, and uptime.

### GET /api/admin/slow-queries

List recent slow queries (requests exceeding `SLOW_QUERY_THRESHOLD_MS`, default 200ms).

```
GET /api/admin/slow-queries?limit=50&min_ms=500
```

```json
{
  "slow_queries": [
    {
      "method": "GET",
      "path": "/api/data/products",
      "duration_ms": 843,
      "status_code": 200,
      "created_at": "2026-01-01T12:00:00Z"
    }
  ]
}
```

### GET /api/admin/rate-limits

List all configurable rate limit tiers (stored in `zv_rate_limit_configs`).

```json
{ "rate_limits": [
  { "key_prefix": "api", "window_ms": 60000, "max_requests": 200 },
  { "key_prefix": "auth", "window_ms": 60000, "max_requests": 10 },
  { "key_prefix": "ai", "window_ms": 60000, "max_requests": 20 },
  { "key_prefix": "write", "window_ms": 60000, "max_requests": 60 }
]}
```

### PATCH /api/admin/rate-limits/:keyPrefix

Update a tier's window or max requests at runtime (no restart needed).

```json
// Request
{ "window_ms": 60000, "max_requests": 500 }
```

### POST /api/admin/rate-limits/reset

Restore all tiers to compiled defaults.

### POST /api/admin/explain

Run `EXPLAIN ANALYZE` on a collection query. **Disabled in production.**

```json
// Request
{
  "collection": "products",
  "sort": "created_at",
  "order": "desc",
  "limit": 20
}

// Response
{ "plan": { "Plan": { "Node Type": "Seq Scan", ... } } }
```

### POST /api/admin/migrate

Run pending database migrations. Returns the count of applied migrations.

### GET /api/admin/types

Returns TypeScript type definitions for all collections as plain text.

---

## Health & System

### GET /api/health

Returns minimal health status. Does not require authentication.

```json
{ "status": "ok" }
```

### GET /api/docs

Swagger UI (if `api_docs_public` setting is enabled).

### GET /api/openapi.json

OpenAPI 3.1 spec for all core endpoints — auth, collections, data CRUD, permissions, users, webhooks, storage. Import into Postman, Swagger UI, or use with any OpenAPI-compatible tool.

### GET /api/sitemap.xml

XML sitemap generated from published pages.
