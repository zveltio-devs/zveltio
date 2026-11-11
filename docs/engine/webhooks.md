# 🔔 Zveltio Webhooks

Complete guide for configuring, consuming, and debugging webhooks.

---

## Table of Contents

- [Overview](#overview)
- [Creating a Webhook](#creating-a-webhook)
- [Event Types](#event-types)
- [Payload Format](#payload-format)
- [Signature Verification](#signature-verification)
- [Retry Logic](#retry-logic)
- [Delivery Logs](#delivery-logs)
- [Webhook API Reference](#webhook-api-reference)
- [Testing Webhooks](#testing-webhooks)

---

## Overview

Webhooks allow Zveltio to notify external systems when data changes. When an event occurs (record created, updated, deleted), Zveltio:

1. Finds the active webhooks matching the event and collection, inside the write's transaction
2. Queues one delivery job per webhook in that same transaction (pg-boss, in Postgres)
3. A worker delivers each with an HMAC-SHA256 signature
4. Failed deliveries retry with exponential backoff, then land in the dead-letter list

### Delivery guarantee

- **The write and its events commit together or not at all.** A write that rolls back queues nothing. A write that commits has queued its events, so an engine that crashes right after still delivers them when a worker starts. This holds for single writes, bulk and sync.
- **A webhook receives the writes whose transaction could see it**: that is what "from the moment it was saved" means.
- **A write whose event cannot be queued fails.** If the job queue is down while a webhook matches, the write answers `503` and no row is written. A collection with no matching webhook does not need the queue.
- **Delivery is at least once.** A receiver can get the same event twice (a retry after a response that was lost, a replay). Deduplicate on the envelope's `id`.
- **Delivery has no order.** A retry reorders events. For two events about one record, keep the one with the higher `sequence`.
- **What is delivered is decided at delivery time.** The job reads the webhook again when it runs: one disabled or deleted since delivers nothing, and the record is shaped as the webhook's `run_as_role` reads it then.

Webhooks do not use Valkey.

---

## Creating a Webhook

### Via Studio

Studio → Webhooks → New Webhook

### Via API

```bash
POST /api/webhooks
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Order notifications",
  "url": "https://your-service.com/hooks/zveltio",
  "events": ["insert", "update"],
  "collections": ["orders"],
  "method": "POST",
  "secret": "your-webhook-secret",
  "retry_attempts": 3,
  "timeout": 5000,
  "run_as_role": "tenant_member",
  "headers": {
    "X-Custom-Header": "value"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | — | Display name |
| `url` | string | — | **Required.** HTTPS endpoint URL |
| `events` | string[] | — | **Required.** Events to listen to (see below) |
| `collections` | string[] | `[]` (all) | Filter by collection name(s) |
| `method` | string | `POST` | HTTP method |
| `secret` | string | auto | HMAC signing secret. If omitted, a 32-byte random secret is auto-generated. **The plaintext secret is returned only once** in the create response. |
| `retry_attempts` | number | `3` | Max delivery attempts (0–10) |
| `timeout` | number | `5000` | Request timeout in ms |
| `headers` | object | `{}` | Custom headers to include |
| `run_as_role` | string | `tenant_member` | The Casbin role the payload is read as. You may only pick a role you hold in this tenant (403 otherwise), on create and on every later edit. |

> **What a delivery carries:** the record as `run_as_role` reads it — that
> role's grants, row rules and column rules. A record the role may not read is
> not delivered at all; a column a column rule hides from it is left out. When
> the role is deleted the webhook delivers nothing until it is saved with a role
> again.

> **Security note:** Subsequent `GET /api/webhooks/:id` calls return the secret masked as `••••••••`. Store the secret securely at creation time.

---

## Event Types

| Event | Trigger |
|-------|---------|
| `insert` | Record created |
| `update` | Record updated (PUT or PATCH) |
| `delete` | Record deleted |
| `*` | All events |

### Collection filtering

```json
// All events on all collections
{ "events": ["*"], "collections": [] }

// Only inserts on 'orders' and 'products'
{ "events": ["insert"], "collections": ["orders", "products"] }

// All events on 'users'
{ "events": ["*"], "collections": ["users"] }
```

---

## Payload Format

Every webhook delivery sends a `POST` request (or your configured method) with this JSON body:

```json
{
  "id": "0b0f4c1e-5a50-4c36-9d5e-2f3f0c8a7d11",
  "sequence": 48211,
  "event": "insert",
  "collection": "orders",
  "timestamp": "2026-03-14T12:00:00.000Z",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "pending",
    "total": 149.99,
    "created_at": "2026-03-14T12:00:00.000Z"
  }
}
```

| Field | Description |
|-------|-------------|
| `id` | One UUID per write: the same for every webhook that receives it, every retry and every replay. Deduplicate on it. |
| `sequence` | A number taken in the write's transaction. Two writes to one record carry increasing values, in commit order. It has gaps and says nothing about two different records. |
| `event` | `insert` / `update` / `delete` |
| `collection` | Collection name (e.g., `orders`) |
| `timestamp` | ISO 8601 UTC timestamp |
| `data` | The record as the webhook's `run_as_role` reads it (for delete: `{ id }` only) |

### Headers sent

```
Content-Type: application/json
X-Zveltio-Signature: sha256=<hmac-hex>  (if secret configured)
<your custom headers>
```

---

## Signature Verification

If a `secret` is configured, every delivery includes an `X-Zveltio-Signature` header with a HMAC-SHA256 signature of the raw request body.

### Algorithm

```
signature = HMAC-SHA256(secret, raw_body)
header = "sha256=" + hex(signature)
```

### Verification examples

#### Node.js / Bun

```typescript
import crypto from 'crypto';

function verifySignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected),
  );
}

// In your handler (Express/Hono/Fastify)
app.post('/hooks/zveltio', (req, res) => {
  const sig = req.headers['x-zveltio-signature'] as string;
  const body = req.rawBody; // raw string, not parsed JSON

  if (!verifySignature(body, sig, process.env.WEBHOOK_SECRET!)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(body);
  // process event...
  res.json({ ok: true });
});
```

#### Python

```python
import hmac
import hashlib

def verify_signature(raw_body: bytes, signature: str, secret: str) -> bool:
    expected = 'sha256=' + hmac.new(
        secret.encode(),
        raw_body,
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)
```

> **Important**: Always use the **raw request body** (before JSON parsing) for signature verification. Parsed and re-serialized JSON may differ.

---

## Retry Logic

A failed delivery is retried by the job queue with exponential backoff, starting at one second, up to the webhook's `retry_attempts`.

A delivery is considered **failed** if:
- HTTP status is not 2xx
- Request times out (default: 5000ms, at most 30 seconds)
- Network error occurs

### Dead-letter list

A delivery whose attempts are exhausted is abandoned and listed:

```bash
GET /api/webhooks/dlq?limit=50
```

```json
{
  "entries": [
    {
      "deliveryId": "uuid",
      "webhookId": "uuid",
      "eventId": "uuid",
      "sequence": 48211,
      "event": "insert",
      "collection": "orders",
      "data": { "id": "…" },
      "timestamp": "2026-03-14T12:00:00.000Z",
      "url": "https://your-service.com/hooks/zveltio",
      "method": "POST",
      "attempt": 4,
      "status": 500,
      "error": null
    }
  ]
}
```

```bash
POST /api/webhooks/dlq/replay
# → { "replayed": 3 }
```

Replay queues every abandoned delivery of the tenant again, with the full retry budget and the same event `id`, so a receiver that did get it once can tell. The list lives in Postgres (`zvd_webhook_deliveries`); there is no size cap to configure.

---

## Delivery Logs

There is one delivery row per webhook and event; each attempt writes its outcome over it. View them in Studio → Webhooks → [webhook name] → Delivery Logs.

### List deliveries

```bash
GET /api/webhooks/:id/deliveries
```

Response:
```json
{
  "deliveries": [
    {
      "id": "uuid",
      "webhook_id": "uuid",
      "event_id": "uuid",
      "payload": { "id": "…", "sequence": 48211, "event": "insert", "collection": "orders", "data": {}, "timestamp": "…" },
      "url": "https://your-service.com/hooks/zveltio",
      "method": "POST",
      "status": 200,
      "attempt": 1,
      "max_attempts": 3,
      "response_body": "{ \"ok\": true }",
      "error": null,
      "delivered_at": "2026-03-14T12:00:00.000Z"
    }
  ]
}
```

`status` is the HTTP status of the last attempt (`null` when no response came). `delivered_at` is set once an attempt succeeded. A row with `delivered_at` null and `attempt` above `max_attempts` is abandoned: it is in the dead-letter list.

---

## Rotating the Signing Secret

If your secret is compromised, rotate it immediately. The new secret takes effect instantly — update your receiver before rotating to avoid delivery failures.

```bash
POST /api/webhooks/:id/rotate-secret
Authorization: Bearer <admin-token>

# Response
{
  "secret": "c9d2f8...",   # new plaintext secret — save it now
  "webhook": { "id": "...", "secret": "••••••••" }
}
```

---

## Webhook API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/webhooks` | List all webhooks (secrets masked) |
| `POST` | `/api/webhooks` | Create webhook (auto-generates secret) |
| `GET` | `/api/webhooks/:id` | Get webhook |
| `PATCH` | `/api/webhooks/:id` | Update webhook |
| `DELETE` | `/api/webhooks/:id` | Delete webhook |
| `POST` | `/api/webhooks/:id/rotate-secret` | Rotate signing secret |
| `POST` | `/api/webhooks/:id/test` | Send test payload with signature |
| `GET` | `/api/webhooks/:id/deliveries` | List delivery history |
| `GET` | `/api/webhooks/dlq` | List abandoned deliveries |
| `POST` | `/api/webhooks/dlq/replay` | Queue every abandoned delivery again |

---

## Testing Webhooks

### Send a test event

```bash
POST /api/webhooks/:id/test
```

Sends a synthetic payload with `event: "test"` to verify your endpoint is reachable.

### Local development with ngrok

```bash
# Expose local port to public URL
ngrok http 3001

# Use the ngrok URL as your webhook URL
# e.g., https://abc123.ngrok.io/hooks/zveltio
```

### Inspect deliveries

The delivery log (`GET /api/webhooks/:id/deliveries`) includes the full request body and response body, making it easy to debug payload issues without external tooling.
