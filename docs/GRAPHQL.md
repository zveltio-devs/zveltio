# GraphQL API

Zveltio auto-generates a GraphQL schema from your collections (zvd_* tables).

## Status: Read-Only (Query)

| Feature | Status |
|---------|--------|
| Queries (SELECT) | ✅ Supported |
| Relations (JOIN) | ✅ Auto-resolved |
| Filtering | ✅ Via arguments |
| Pagination | ✅ limit/offset |
| Auth (session cookie) | ✅ Required |
| Casbin permissions | ✅ Enforced per collection |
| Mutations (INSERT/UPDATE/DELETE) | ❌ Use REST API |
| Subscriptions (realtime) | ❌ Use WebSocket /api/ws |

## Usage

### Interactive Playground
Open `http://localhost:3000/api/graphql` in your browser.

### Query Example
```graphql
query {
  products(limit: 10, sort: "created_at", order: "desc") {
    id
    name
    price
    created_at
  }
}
```

### With Relations
```graphql
query {
  orders {
    id
    total
    customer {
      name
      email
    }
  }
}
```

### Refresh Schema
After creating or modifying collections, refresh the GraphQL schema:
```bash
curl -X POST http://localhost:3000/api/graphql/refresh-schema \
  -H "Cookie: session=YOUR_SESSION"
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/graphql` | GET | GraphiQL interactive playground |
| `/api/graphql` | POST | Execute GraphQL queries |
| `/api/graphql/refresh-schema` | POST | Refresh auto-generated schema (admin) |

> **Note:** GraphQL is auto-generated from your collections and supports queries with relations. Mutations and subscriptions are not yet supported — use the REST API for write operations and WebSocket for realtime.

## Why Read-Only?
Zveltio's REST API (POST/PUT/DELETE /api/data/:collection) handles write operations with full Casbin permission checks, webhook triggers, revision tracking, and real-time broadcast. Duplicating this in GraphQL mutations would create maintenance burden without added value.

For realtime, use WebSocket at `/api/ws` which supports subscribe/unsubscribe per collection with automatic reconnection.
