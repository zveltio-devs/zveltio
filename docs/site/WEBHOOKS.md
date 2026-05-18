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

1. Finds all active webhooks matching the event + collection
2. Queues them via Valkey (`webhook:queue`)
3. A background worker delivers them with HMAC-SHA256 signatures
4. Failed deliveries retry with exponential backoff

Without Valkey configured, webhooks fire-and-forget directly (no retry).

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
| `event` | `insert` / `update` / `delete` |
| `collection` | Collection name (e.g., `orders`) |
| `timestamp` | ISO 8601 UTC timestamp |
| `data` | Full record snapshot (for delete: `{ id }` only) |

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

When Valkey is configured, failed deliveries are retried automatically with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1st retry | 1 second |
| 2nd retry | 2 seconds |
| 3rd retry | 4 seconds |
| (n-th retry) | 2^(n-1) seconds |

A delivery is considered **failed** if:
- HTTP status is not 2xx
- Request times out (default: 5000ms)
- Network error occurs

After all retry attempts are exhausted, the delivery is marked `failed` in the delivery log. No dead-letter queue by default — monitor via delivery logs.

### Without Valkey

Without `VALKEY_URL` configured, webhooks are fire-and-forget with no retry. Configure Valkey for production reliability.

---

## Delivery Logs

Every delivery attempt is recorded. View logs in Studio → Webhooks → [webhook name] → Delivery Logs.

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
      "event": "insert",
      "collection": "orders",
      "url": "https://your-service.com/hooks/zveltio",
      "status": "success",
      "status_code": 200,
      "attempt": 1,
      "request_body": "{ ... }",
      "response_body": "{ \"ok\": true }",
      "duration_ms": 142,
      "delivered_at": "2026-03-14T12:00:00.000Z"
    }
  ]
}
```

| Status | Description |
|--------|-------------|
| `success` | HTTP 2xx received |
| `failed` | All retry attempts exhausted |
| `pending` | Queued, not yet attempted |

### Retry a failed delivery

```bash
POST /api/webhooks/:id/deliveries/:deliveryId/retry
```

Forces an immediate re-delivery regardless of retry count.

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
| `POST` | `/api/webhooks/:id/deliveries/:deliveryId/retry` | Retry a delivery |

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
