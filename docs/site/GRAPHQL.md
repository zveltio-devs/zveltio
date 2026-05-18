# GraphQL API

Zveltio includes a fully-featured GraphQL API as an optional extension (`developer/graphql`). It auto-generates a live schema from your collections and relations, with DataLoader batching to prevent N+1 queries.

## Enabling GraphQL

Add `developer/graphql` to your `ZVELTIO_EXTENSIONS` environment variable:

```env
ZVELTIO_EXTENSIONS=developer/graphql
```

This mounts the GraphQL API at `/api/graphql` and registers all endpoints below.

---

## Capabilities

| Feature | Status |
|---------|--------|
| Queries (list + get by ID) | ✅ Supported |
| Mutations (create, update, delete) | ✅ Supported |
| Relations (m2o, o2m, m2m) | ✅ Auto-resolved |
| DataLoader batching (N+1 prevention) | ✅ Enabled |
| Filtering, limit, offset | ✅ Via arguments |
| Auth (session cookie) | ✅ Required |
| Casbin permission checks | ✅ Enforced per collection |
| GraphiQL interactive playground | ✅ Built-in |
| Persisted queries | ✅ Admin-managed |
| Field-level access policies | ✅ Per role |
| Operation logs & stats | ✅ Admin dashboard |
| Subscriptions (real-time) | ❌ Use WebSocket `/api/realtime` |

---

## Interactive Playground

Open `http://localhost:3000/api/graphql` in your browser.

---

## Query Examples

### List records
```graphql
query {
  list_products(limit: 10, offset: 0) {
    id
    name
    price
    created_at
  }
}
```

### Get by ID
```graphql
query {
  get_products(id: "uuid-here") {
    id
    name
    price
  }
}
```

### With relations
```graphql
query {
  list_orders {
    id
    total
    customer_id {
      name
      email
    }
  }
}
```

---

## Mutation Examples

### Create
```graphql
mutation {
  create_products(name: "Widget", price: 29.99) {
    id
    created_at
  }
}
```

### Update
```graphql
mutation {
  update_products(id: "uuid-here", price: 24.99) {
    id
    price
    updated_at
  }
}
```

### Delete
```graphql
mutation {
  delete_products(id: "uuid-here")
}
```

> **Note:** Mutations bypass webhook triggers and revision tracking. For write operations that need those features, use the REST API (`POST/PUT/DELETE /api/data/:collection`).

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/graphql` | GET | GraphiQL interactive playground |
| `/api/graphql` | POST | Execute query or mutation |
| `/api/graphql/refresh-schema` | POST | Invalidate schema cache (admin) |
| `/api/graphql/persisted` | GET | List persisted queries |
| `/api/graphql/persisted` | POST | Create persisted query (admin) |
| `/api/graphql/persisted/:name/execute` | POST | Run persisted query by name |
| `/api/graphql/persisted/:id` | DELETE | Delete persisted query (admin) |
| `/api/graphql/logs` | GET | Operation logs (admin) |
| `/api/graphql/stats` | GET | Aggregate stats (admin) |
| `/api/graphql/field-policies` | GET/POST/DELETE | Field-level access policies (admin) |

---

## Persisted Queries

Store commonly used queries on the server and execute them by name. Useful for limiting what clients can query and reducing query size over the wire.

```bash
# Create a persisted query (admin)
curl -X POST http://localhost:3000/api/graphql/persisted \
  -H "Cookie: session=..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "active-products",
    "query": "query { list_products(filter_id_in: []) { id name price } }",
    "is_public": false,
    "allowed_roles": ["manager", "employee"]
  }'

# Execute by name
curl -X POST http://localhost:3000/api/graphql/persisted/active-products/execute \
  -H "Cookie: session=..."
```

---

## Schema Refresh

The schema is cached for 60 seconds. After creating or modifying collections, force a refresh:

```bash
curl -X POST http://localhost:3000/api/graphql/refresh-schema \
  -H "Cookie: session=YOUR_SESSION"
```

---

## Query Depth Limit

To prevent deeply nested denial-of-service queries, the extension enforces a maximum depth of **5 levels**. Queries exceeding this return a 400 error.

---

## Why a separate extension?

GraphQL adds the `graphql` npm package (~3MB) and runtime schema-building overhead. Not every deployment needs it. Keeping it as an opt-in extension means zero cost for projects that only use REST.
