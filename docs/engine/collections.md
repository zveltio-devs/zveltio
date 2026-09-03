# Dynamic Collections

Create database tables without writing SQL using Zveltio's dynamic collection system.

## Overview

A **collection** is a database table managed through the API. You define the schema (fields), and Zveltio creates the table, generates CRUD endpoints, and keeps everything in sync — no migrations to write.

> **Zero-downtime DDL** — Table and column creation happens without locking, keeping your application available during schema changes. See [Ghost DDL](/ghost-ddl) for the technical details.

## Creating a Collection

```json
POST /api/collections
{
  "name": "products",
  "fields": [
    { "name": "title",       "type": "text",     "required": true },
    { "name": "price",       "type": "number",   "required": true },
    { "name": "description", "type": "richtext" },
    { "name": "in_stock",    "type": "boolean",  "default": true }
  ]
}
```

The response is `202 Accepted` with a `job_id`. Table creation is async — poll `GET /api/collections/:name` until `status: "ready"`.

## Field Types

| Type | SQL type | Description | Options |
|------|----------|-------------|---------|
| `text` | `VARCHAR(255)` | Short text | `maxLength`, `required` |
| `textarea` | `TEXT` | Long plain text | `required` |
| `richtext` | `TEXT` | HTML rich text (Tiptap) | `required` |
| `number` | `NUMERIC` | Integer or decimal | `precision`, `scale`, `required` |
| `integer` | `INTEGER` | Whole numbers | `required` |
| `float` | `FLOAT8` | Floating point | `required` |
| `boolean` | `BOOLEAN` | true / false | `default` |
| `date` | `DATE` | Date without time | `required` |
| `datetime` | `TIMESTAMPTZ` | Date with timezone | `required` |
| `email` | `VARCHAR(255)` | Validated email address | `required` |
| `url` | `TEXT` | Validated URL | `required` |
| `uuid` | `UUID` | UUID v4 | `required` |
| `json` | `JSONB` | Arbitrary JSON object | `required` |
| `file` | `TEXT` | File reference (storage ID) | `required` |
| `image` | `TEXT` | Image reference | `required` |
| `enum` | `TEXT` | Constrained string values | `options[]`, `required` |
| `tags` | `TEXT[]` | Array of strings | `required` |
| `color` | `VARCHAR(9)` | Hex color code | `required` |
| `phone` | `VARCHAR(30)` | Phone number | `required` |
| `slug` | `VARCHAR(255)` | URL-safe slug | `required` |
| `password` | `TEXT` | Hashed password field | `required` |
| `reference` | `UUID` | Foreign key to another collection | `collection`, `required` |
| `m2o` | `UUID` | Many-to-one relation | `collection` |
| `o2m` | — | One-to-many (virtual) | `collection`, `foreignKey` |
| `m2m` | — | Many-to-many (junction table) | `collection` |
| `m2a` | — | Many-to-any (polymorphic) | |
| `location` | `POINT` | Lat/lng point (PostGIS) | `required` |
| `geometry` | `GEOMETRY` | PostGIS geometry | `required` |
| `vector` | `vector(N)` | pgvector embedding | `dimensions` |
| `computed` | — | Formula field (not stored) | `expression` |

## API Endpoints

Once a collection is created, all CRUD endpoints are available automatically:

```
GET     /api/data/:collection           — List records
POST    /api/data/:collection           — Create record
GET     /api/data/:collection/:id       — Get record
PATCH   /api/data/:collection/:id       — Update record
PUT     /api/data/:collection/:id       — Replace record
DELETE  /api/data/:collection/:id       — Soft delete
GET     /api/data/:collection/:id/timeline — Revision history
```

And schema endpoints:

```
GET     /api/collections                — List all collections
POST    /api/collections                — Create collection
GET     /api/collections/:name          — Get schema
PATCH   /api/collections/:name          — Update schema (add/modify fields)
DELETE  /api/collections/:name          — Drop collection
```

## Filtering

Pass a `filter` query param as a JSON object:

```
GET /api/data/products?filter={"category":"electronics","price":{"_gt":100}}
```

Supported filter operators:

| Operator | Description |
|----------|-------------|
| *(none)* | Equals |
| `_gt` | Greater than |
| `_gte` | Greater than or equal |
| `_lt` | Less than |
| `_lte` | Less than or equal |
| `_in` | In array |
| `_nin` | Not in array |
| `_like` | SQL LIKE pattern |
| `_ilike` | Case-insensitive LIKE |
| `_null` | Is null / is not null |
| `_between` | Between two values |

## Sorting & Pagination

```
GET /api/data/products?sort=price:asc&limit=20&offset=40
```

## Relationships

Use `reference` or relation field types to link collections:

```json
{
  "name": "products",
  "fields": [
    {
      "name": "category_id",
      "type": "reference",
      "reference": "categories"
    }
  ]
}
```

For many-to-many, Zveltio creates a junction table automatically:

```json
{ "name": "tags", "type": "m2m", "collection": "tags" }
```

Related records can be expanded in queries using the `expand` parameter:

```
GET /api/data/products?expand=category_id
```

## Validation

Add validation rules at field level or using the Validation Rules engine:

```json
{
  "name": "email",
  "type": "email",
  "required": true,
  "unique": true
}
```

For complex business rules, use `POST /api/validation-rules` to create natural language rules (e.g. *"price must be greater than cost"*) that are enforced on every write.

## Schema Branches

Before making breaking schema changes in production, create a branch:

1. Go to **Studio → Schema Branches**
2. Create a branch from `main`
3. Apply changes on the branch
4. Preview the diff
5. Merge when ready

See [Schema Branches](/architecture) for details.

## Time Travel

Query historical data by passing an `as_of` timestamp:

```
GET /api/data/products?as_of=2026-01-15T10:00:00Z
```

Returns the state of records as they existed at that point in time, using revision history. See also `GET /api/data/:collection/:id/timeline` for per-record history.

## Virtual Collections

Collections don't have to be backed by a physical table. Virtual collections are computed from SQL views or aggregations:

```json
POST /api/virtual-collections
{
  "name": "monthly_revenue",
  "query": "SELECT date_trunc('month', created_at) as month, SUM(amount) as total FROM orders GROUP BY 1"
}
```

Virtual collections are read-only and support the same filtering/sorting API.
