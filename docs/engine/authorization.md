# 🔐 Zveltio Authorization Guide

Complete guide to authentication and authorization in Zveltio, including the Emergency Admin Access system.

---

## Table of Contents

- [Authentication](#authentication)
- [Authorization](#authorization)
- [Emergency Admin Access](#emergency-admin-access)
- [RBAC Policies](#rbac-policies)
- [API Security](#api-security)

---

## Authentication

Zveltio uses **Better-Auth** for authentication with the following features:

### Supported Auth Methods

- **Email/Password** - Traditional login with bcrypt hashing
- **OAuth** - Google, GitHub, and other providers
- **Magic Links** - Passwordless email authentication
- **2FA** - TOTP-based two-factor authentication

### Session Management

```typescript
// Session configuration
{
  sessionMaxAge: 7 * 24 * 60 * 60, // 7 days
  sessionUpdateAge: 24 * 60 * 60,   // Refresh daily
  sessionCookie: {
    httpOnly: true,    // Prevent XSS
    secure: true,      // HTTPS only
    sameSite: 'strict', // CSRF protection
    path: '/'
  }
}
```

### Login Flow

```bash
# Sign in
POST /api/auth/sign-in/email
{
  "email": "user@example.com",
  "password": "securepassword"
}

# Response includes session cookie
Set-Cookie: better-auth.session_token=...
```

---

## Authorization

### Overview

Zveltio uses **Casbin** for RBAC (Role-Based Access Control) with:

1. **Casbin Policies** - Standard RBAC rules
2. **Emergency Admin Access** - Special role with unlimited access

### Permission Check Flow

```
Request → Session Verification → Emergency Admin Check → Casbin Policy Check → Allow/Deny
```

---

## Emergency Admin Access

### What is Emergency Admin Mode?

The **Emergency Admin Access** is a special authorization mechanism that ensures platform administrators can never be locked out of their own system. A user with `role='god'` bypasses all Casbin permission checks.

This is a disaster recovery feature — if someone accidentally deletes all Casbin policies, the Emergency Admin can still access the system and restore the correct permissions.

### How It Works

In [`packages/engine/src/lib/tenancy/permissions.ts`](../../packages/engine/src/lib/tenancy/permissions.ts):

```typescript
export async function checkPermission(
  userId: string,
  resource: string,
  action: string,
): Promise<boolean> {
  // ═══ HARDCODED EMERGENCY ADMIN ACCESS ═══
  // Independent of Casbin — even if ALL policies are deleted,
  // a user with role='god' will ALWAYS have full access.
  const isGod = await isGodUser(userId);
  if (isGod) return true; // 🚀 Emergency Admin bypass!

  // ... normal Casbin permission check
}
```

### Creating an Emergency Admin (Super-Admin)

Use the CLI to create a Super-Admin user:

```bash
# Create Super-Admin (Emergency Admin) user
bun run packages/cli/src/index.ts create-god

# Interactive prompts:
# Email: admin@your-company.com
# Name: System Admin
# Password: *********
```

> ⚠️ **Important:** The CLI must set `role: 'god'` in the database, not `'admin'`. This was a bug in previous versions.

### Verify Emergency Admin Status

```sql
-- Check user role
SELECT id, email, name, role FROM "user" WHERE role = 'god';
```

---

## RBAC Policies

### Policy Format

Casbin policies use the format:

```
p, subject, resource, action, scope
```

### Default Policies

```csv
# Admin - Full access to everything
p, admin, *, *, ALL

# Manager - Read org data, write dept data
p, manager, data, read, ORGANIZATION
p, manager, data, write, DEPARTMENT

# Employee - Read/Write own data only
p, employee, data, read, OWN
p, employee, data, write, OWN

# Guest - Read-only access
p, guest, data, read, OWN
```

### Scope Types

| Scope          | Description                |
| -------------- | -------------------------- |
| `ALL`          | Access to everything       |
| `ORGANIZATION` | Access within organization |
| `DEPARTMENT`   | Access within department   |
| `OWN`          | Access to own records only |

### Role Assignment

Assign Casbin roles and policies via the API:

```bash
# Assign a named role to a user
POST /api/permissions/roles
{ "userId": "user-uuid", "role": "manager" }

# Grant direct collection access to a user
POST /api/permissions/policies
{ "subject": "user-uuid", "resource": "products", "action": "read" }

# Grant full access to all resources
POST /api/permissions/policies
{ "subject": "manager-role", "resource": "*", "action": "*" }
```

> **Note:** Collection resources use the collection name directly — `"products"`, not `"data:products"`. System resources are: `admin`, `storage`, `approvals`.

### Permission Check in Code

```typescript
import { checkPermission } from './lib/permissions.ts';

const canAccess = await checkPermission(userId, 'products', 'read');
if (!canAccess) {
  return c.json({ error: 'Forbidden' }, 403);
}
```

---

## Collection permissions in the database

A collection grant (`read`, `create`, `update`, `delete` on a collection) is
enforced twice: by the application's `checkPermission`, and by Postgres. Every
collection table carries four RESTRICTIVE policies — `zv_coll_read` (SELECT),
`zv_coll_create` (INSERT), `zv_coll_update` (UPDATE), `zv_coll_delete`
(DELETE) — so a path that never asks the application (a new route, an
extension's query) is refused by the table.

The request publishes what the caller may do, resolved exactly as
`checkPermission` resolves it (role chains, the tenant and `*` domains — roles
come from Casbin alone, `member` included); the policies read that set. A statement passes when:

| Who | Collection rights in the database |
|---|---|
| god, `data:view_all`, an API key with `rls_bypass` whose issuer holds `data:view_all` | all (`zveltio.rls_bypass`) |
| a signed-in user | their grants; a tenant admin's `('*','*')` is everything |
| an API key | its scopes (`write` = create + update, `*` = all), met with its issuer's grants; `rls_bypass` only while the issuer holds `data:view_all` |
| an anonymous request | the **tenant's `public` role**, in the tenant resolved for the request |
| the engine's own work with no actor (boot, jobs, reconcilers) | all |
| an extension's statement in a request | the requesting user's grants |
| a worker-isolated extension's statement in a request | the requesting user's grants — never the bypass, never another tenant |
| an extension's statement with no actor (a hook, a timer) | nothing — unless the extension holds `data:system`, whose jobs in `withTenantIsolation` are system inside the tenant |
| inside `ctx.internals.asSystem(collections, fn)` | those collections (capability `data:system`, audited) |
| an extension listed in `ZVELTIO_COLLECTION_RLS_EXEMPT` | all — a temporary bridge, warned at boot, removed at 3.0.0 GA |

Tenant isolation and the row rules apply in every case; "system" is always
system **inside** the tenant.

Public pages and forms are configuration, not code: grant the `public` role
`read` on the collection (with a row rule such as `status = 'published'`), or
`create` without `read` on a form's response collection. Postgres applies the
SELECT policy to `INSERT … RETURNING`, `ON CONFLICT` and the `WHERE` of an
`UPDATE`/`DELETE`, so for a caller without `read` the engine runs its own
statements on that one collection inside a read window (`withCollectionRead`)
that never reaches the response. Such a caller gets the row's id and nothing
more: `{ id }` from a create, `{ success, id }` from an update or delete, ids
or counts alone from bulk and sync push; a caller with `read` gets the full row. Tenant
isolation and row rules still apply.

Measured on Postgres 18: +20 µs per statement against the tenant policy alone
(20 000 re-planned primary-key reads).

## Column write permissions in the database

A column permission (`zvd_column_permissions`: `can_read`, `can_write` per
collection, column and role) is enforced twice on writes. The data API's filter
refuses the request first, naming the fields (403). Under it, a collection with
any column its role may not write (or read — a hidden column is not writable
either) carries a `_zv_column_guard` BEFORE INSERT/UPDATE trigger
(`zveltio_column_guard()`, migration 072), compiled from those rows and rebuilt
whenever they change. For the request's role and for `*`:

- an UPDATE may not change the column (writing the same value passes);
- an INSERT may only leave it at its default (`NULL` when it has none). A
  default that is not reproducible, such as `gen_random_uuid()`, cannot be told
  from a chosen value, so that column is not checked on INSERT.

The system columns (`id`, timestamps, `created_by`/`updated_by`, `tenant_id`,
search columns) are never checked: the engine sets them. `status` is not one:
a collection that has it declares it, and its rules apply like any field's. A refused
write is `42501`, answered as 403 `column_write_denied`.

| Who | Column write rules in the database |
|---|---|
| a signed-in user, an anonymous request, an API key | their role's rules and the `*` rules (role `api_key` for a key) |
| `data:view_all_columns` (a god holds it) | none — the same exemption the engine's filter grants |
| an extension's statement in a request (`ctx.db`, a hook) | the requesting user's |
| a worker-isolated extension's statement | the requesting user's, never their exemption |
| inside `ctx.internals.asSystem(collections, fn)` | none on those collections |
| the engine's own work with no actor (boot, jobs, flows) | none |
| a write the schema causes (`ON DELETE SET NULL`, a trigger's statement) | none |

## Columns no one may read

A field whose type serializes to nothing — `password`, stored as an argon2
hash — is served to no one, god included. The data API strips it from every
payload; the database refuses it too (`zveltio_seal_columns()`, migration 073).
Such a collection's table holds SELECT column by column, on every column but
the sealed ones, for every role that reads it (`zveltio_rls`,
`zveltio_worker`, `zveltio_flow_reader`, `zveltio_ext` and the per-extension
roles); INSERT, UPDATE and DELETE stay table-level, so writing a new hash needs
no read of the old one. Only the table's owner can read the column.

- `SELECT pw …`, `SELECT * …`, `RETURNING *`, or an expression naming the column
  (`SET title = pw`) on a request role is refused with `42501`.
- The engine names the columns it may read (`readableColumns` in
  `db/dynamic.ts`) on every read and write path: list, get, the write echoes,
  bulk, `?expand=`, revisions, sync pull and push, and an extension's record
  hooks. Extension SQL, a flow `query_db` step and an insight must name their
  columns on such a collection.
- Re-applied in the CREATE's transaction, with a field's ADD, on every field
  rename, retype and drop, and at boot; the boot grant loops leave a sealed
  table's SELECT alone. Dropping the last such field gives the table-level
  SELECT back.
- Revisions do not store the hash (`zv_revisions` is readable on the request
  role). Reverting a record never touches its password.

Fields marked `encrypted: true` are not sealed: the database holds only
ciphertext under a key it never sees, and the data API decrypts them on every
ordinary read.

## Column read permissions in the database

A column with `can_read = false` for a role is hidden by the data API
(`applyColumnAccess`) and by the database too (`zveltio_mask_columns()`,
migration 075). Every collection has a view `zvv_<collection>` over its table:
a column with a read rule is served as `NULL` to an actor the rule hides it
from, every other column passes through, and an unserved column (`password`)
is not in the view at all. `search_vector` and `search_text` are built from
every text field, so they are hidden wherever one of those is.

| Who | Hidden columns through the view |
|---|---|
| a signed-in user, an anonymous request, an API key | `NULL` where a rule names their role or `*` |
| `data:view_all_columns` (a god holds it) | none |
| inside `ctx.internals.asSystem(collections, fn)` | none on those collections |
| the engine's own work with no actor (boot, jobs, flows) | none |
| the engine reading a written row for itself (before-row, `RETURNING`) | none — revisions, hooks and webhooks see the row as before; the payload is masked where it is served |

The view reads the table as its owner, and the request roles (`zveltio_rls`
and every role that mirrors it) lose SELECT on a ruled column of the table
itself, as on a sealed one: `SELECT salary …` on the table is `42501`, and the
view is the only way to the column. Tenant isolation still binds the view —
the table is FORCE RLS, and its policies read the request's settings, not the
role. Where the owner is a SUPERUSER or BYPASSRLS role, or the table is not
FORCE, a view read as the owner would see every tenant, so there the view is
`security_invoker` and the ruled columns stay granted: the engine's reads are
masked, raw SQL on the table is not.

- The engine reads through the view on list, get, `?expand=`, saved queries,
  sync pull and the write echoes; a write returns `id` and reads the row back
  through it. A schema-branch preview reads the branch's tables, as before.
- The view is rebuilt with every rule change, in the CREATE's transaction, with
  every field add, rename, retype and drop, and at boot. A transaction that
  alters a collection's columns drops the view first and builds it last: SQL
  that runs `ALTER TABLE … DROP COLUMN` or `… TYPE` on a collection table by
  hand must `DROP VIEW zvv_<collection>` first; the next boot puts it back.
- Extension SQL, a flow `query_db` step and an insight read the table and must
  name their columns on a collection with a read rule, as on a sealed one.

The settings the view reads are the request's own, and raw SQL on the request
role can set them: the view stops the engine and the narrow roles forgetting a
rule, not a caller who forges an actor — the same limit as the write guard
above.

Revisions are masked the same way (`zveltio_mask_revisions()`, migration 077).
`zv_revisions` keeps the whole row in `data` and `delta`, hidden columns
included — the history an admin reads and a revert restores from. The request
roles hold no SELECT on those two columns; they read `zvv__revisions`, which
drops from both the keys a rule hides from the actor in the row's collection,
and `search_vector`/`search_text`, and stands down for the same actors as the
collection views. The engine reads it for `/api/revisions`,
`/api/admin/revisions` and `?as_of=`. Extension SQL that reads `zv_revisions`
(`content/drafts` counts revisions) must name its columns, and cannot name
`data` or `delta`.

## Row-Level Security (RLS)

RLS adds a second authorization layer **below Casbin**: after a role is granted access to a collection, RLS policies control *which records* within that collection the user can see. Policies are implemented at the application layer and are fully visible and editable from Studio — no SQL knowledge required.

### How it works

```
Request
  → Casbin: can role X access collection Y? (yes/no)
    → RLS: inject WHERE clauses for user context
      → Query PostgreSQL
```

Multiple matching policies are **ANDed** together (most restrictive wins).

**Bypasses:** god users and API keys are never filtered by RLS.

### Policy structure

| Field | Description |
|-------|-------------|
| `collection` | Collection slug, or `*` for all collections |
| `role` | Casbin role name, or `*` for all roles |
| `filter_field` | Column to filter on (e.g. `created_by`, `tenant_id`) |
| `filter_op` | `eq`, `neq`, `in`, `not_in` |
| `filter_value_source` | Where the value comes from (see below) |
| `is_enabled` | Toggle without deleting |

### Value sources

| Source | Resolved value |
|--------|---------------|
| `user_id` | The authenticated user's UUID |
| `user_email` | The authenticated user's email address |
| `user_role` | The authenticated user's role string |
| `static:VALUE` | A literal value (e.g. `static:published`) |

### Common examples

**Users see only their own records:**
```
collection: orders   role: member
filter_field: created_by   op: eq   source: user_id
```

**Only published records are visible to guests:**
```
collection: *   role: guest
filter_field: status   op: eq   source: static:published
```

**Tenant isolation:**
```
collection: *   role: *
filter_field: tenant_id   op: eq   source: user_id
```

### Managing policies

Policies are managed in **Studio → Row Security** (Users & Access section) or via the API:

```bash
# List all policies
GET /api/admin/rls

# Create a policy
POST /api/admin/rls
{
  "collection": "orders",
  "role": "member",
  "filter_field": "created_by",
  "filter_op": "eq",
  "filter_value_source": "user_id",
  "is_enabled": true,
  "description": "Members see only their own orders"
}

# Update
PATCH /api/admin/rls/:id

# Delete
DELETE /api/admin/rls/:id
```

All RLS admin endpoints require `admin` role.

### RLS vs Casbin — when to use which

| Need | Use |
|------|-----|
| "Can role X access collection Y at all?" | Casbin |
| "Which records in collection Y can user X see?" | RLS |
| "User X cannot access collection Y at all" | Casbin deny |
| "User X can only see their own rows in Y" | RLS |

---

## API Security

### Rate Limiting

Zveltio rate-limits every surface per user, API key or IP (for example `api` 200 requests/minute, `auth` 10/minute), with an optional per-tenant limit on top. The tiers, their defaults and how to tune them are in [Security → Rate Limiting](../platform/security.md#rate-limiting).

### CORS Configuration

Configure allowed origins in `.env`:

```env
CORS_ORIGINS=https://studio.yourdomain.com,https://client.yourdomain.com
```

> ⚠️ Never use wildcard `*` in production!

### Input Validation

All API inputs are validated with Zod:

```typescript
import { z } from 'zod';

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100),
  password: z.string().min(8),
});
```

### SQL Injection Prevention

Zveltio uses **Kysely** with parameterized queries:

```typescript
// ✅ SAFE - Parameterized query
await db.selectFrom('users').where('email', '=', userInput).execute();

// ❌ NEVER DO THIS
await sql.raw(`SELECT * FROM users WHERE email = '${userInput}'`);
```

---

## Security Best Practices

1. **Use strong passwords** - Minimum 8 characters with mixed case, numbers, symbols
2. **Enable 2FA** - Especially for admin users
3. **Limit Emergency Admins** - Only create one Super-Admin user for emergency access
4. **Review permissions** - Regularly audit Casbin policies
5. **Use HTTPS** - Always use SSL/TLS in production
6. **Rotate secrets** - Change `BETTER_AUTH_SECRET` periodically

---

## Troubleshooting

### "Permission denied" errors

1. Check user role in database: `SELECT role FROM "user" WHERE email = '...'`
2. Verify Casbin policies: `SELECT * FROM zvd_permissions`
3. If user should have Emergency Admin access, update role: `UPDATE "user" SET role = 'god' WHERE email = '...'`

### Cannot create Emergency Admin user

1. Ensure database is running
2. Check database connection in `.env`
3. Verify Better-Auth is initialized: `bun run -T packages/engine/src/db/migrate.ts`

### Locked out — no god user exists

If you've lost access to all god users, use the **bootstrap recovery endpoint**:

```bash
# 1. Set RECOVERY_TOKEN in your .env (min 32 chars) and restart the engine
RECOVERY_TOKEN=your-secure-recovery-token-min-32-chars

# 2. Call the bootstrap endpoint
curl -X POST http://localhost:3000/api/permissions/bootstrap \
  -H "Authorization: Bearer your-secure-recovery-token-min-32-chars" \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@yourapp.com"}'
```

Remove `RECOVERY_TOKEN` from `.env` after recovery.

A god who lost every passkey and authenticator app cannot step up, so cannot
install or change extensions. Send `"clear_factors": true` in the same request to
remove that account's factors; then add a passkey again from the account page.

### Session issues

1. Check cookie settings in browser DevTools
2. Verify `BETTER_AUTH_SECRET` is set in `.env`
3. Ensure `BETTER_AUTH_URL` matches your deployment URL
