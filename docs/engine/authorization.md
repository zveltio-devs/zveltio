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

### Extension configuration needs the step-up window

An extension request is configuration when its method is not GET, HEAD or
OPTIONS and its permission check grants the `admin` object —
`ctx.checkPermission(uid, 'admin', …)`, `ctx.internals.isTenantAdmin` or
`ctx.internals.requireInstanceAdmin`, in-process or in a worker, under `/ext/*`
or on a route the extension put on the global app. Without the session's
step-up window that check throws, and the request answers what an `/api/*`
configuration change answers: 403 `step_up_required` (or
`step_up_enrollment_required`; 403 `Session required` for an API key), rolled
back, even when the extension caught the throw. A check that refuses `admin`
stays a plain refusal, so a non-administrator is never asked to step up. There
is no manifest field and no list: the check is the classification.

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
| an extension's work with no caller (its own `ctx.internals.withTenantIsolation`, a per-tenant schedule, a listener, a worker statement outside a request) | nothing — unless the extension holds `data:system`, whose work in `withTenantIsolation` is system inside the tenant. It is an actor with no identity (see below) |
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
A `secret` field is sealed the same way; it is stored encrypted, and the
engine decrypts it only into the `host.collections` reads of the extension that
owns the collection (ADR 0024) — in its actions, jobs and routes (ADR 0025; a
route of an inline extension inside `ctx.internals.asSystem` reads the named collections as the
extension, so a public sign-in route reaches its own settings).

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

RLS adds a second authorization layer **below Casbin**: after a role is granted access to a collection, RLS policies control *which records* within that collection the user can see and write. Policies are implemented at the application layer and are fully visible and editable from Studio — no SQL knowledge required.

### How it works

```
Request
  → Casbin: can role X access collection Y? (yes/no)
    → RLS: inject WHERE clauses for user context
      → Query PostgreSQL
```

Multiple matching policies are **ANDed** together (most restrictive wins).

**The exemption covers reads only (ADR 0037).** A caller holding
`data:view_all` (a god holds it) reads every row whatever the row rules say, and
so does an API key with `rls_bypass` whose issuer holds `data:view_all`, and a
flow whose `run_as_role` holds it. Nobody is exempt on a write: an insert, an
update and a delete meet every rule that applies to the caller, on the row as it
is and on the row as it would become. A caller who can read a row under the
exemption and may not write it gets `403 row_level_security_violation`, not
"Record not found". So under `* created_by eq user_id` an administrator sees
every row and cannot edit or delete another user's; under a decision
collection's `* author neq user_id` (ADR 0016) a god cannot decide their own
row.

**A rule binds the roles it names.** A rule for `*` binds everyone on writes, a
god included. A rule for `member` binds a caller who holds `member`, and every
account does unless the role was taken from it. To let administrators edit other
users' rows, name the roles the rule is meant for instead of `*`, and make sure
the administrators do not hold one of them. There is no permission that writes
past a row rule.

Any other API key is filtered by its own rules (role
`api_key`, and `*`, resolved against the key's author: `user_id` and
`user_email` are its issuer's — ADR 0028 — or empty when it has none) AND by
its issuer's — the rules of the issuer's roles and
`*`, resolved against the issuer as their own session would be. A key never
sees a row its issuer could not. The issuer's half is waived while the issuer
holds `data:view_all`; a key whose issuer is unknown sees no row a rule covers.
An extension job is filtered the same way, with the user who enqueued it as the
issuer: its `api_key`/`*` rules resolved against that user AND that user's own
rules, so a job never sees a row its author could not (ADR 0028, ADR 0027 §3).
A job with no author — enqueued by a public route — has no issuer half and is
bounded by its manifest; `user_id`/`user_email` own no row for it. Only row
rules work this way: a job's grants are its manifest's declared collections.
**Extension work with no caller is an actor with no identity (ADR 0040).** An
extension's own `ctx.internals.withTenantIsolation`, a per-tenant schedule, a
listener, a worker statement outside a request and an inline service such a
worker calls all run with the actor present and empty: user id and email `''`,
no role, as a job with no author. A rule on `user_id`, `user_email` or
`user_role` therefore keeps no row for that work: it reads none, an insert is
refused, an update or delete touches none. `author neq user_id` is decided on
`''` by the rule's operator, so that work cannot decide a row either. A
`static:` rule binds as for anyone. `data:system` and
`ZVELTIO_COLLECTION_RLS_EXEMPT` answer the collection question only; neither
gives the rows a row rule withholds. An extension that must write a row on a
user's behalf does it as that user: an action, `asSystem` inside a route, or a
job with an author. Only the engine's own work (tenant purge, boot reconcile)
has no actor.

The database applies the same two halves, as one RESTRICTIVE policy per
command: `zv_row_rules` (`SELECT`, the only one that reads the exemption),
`zv_row_rules_insert`, `zv_row_rules_update` and `zv_row_rules_delete`. A write
policy stands down only for the engine's own work with no actor (tenant purge);
no caller can reach that state.

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
| `user_id` | The authenticated user's UUID; for an API key, its issuer's; for an extension job, the user who enqueued it |
| `user_email` | That user's email address, compared without case |
| `user_role` | The authenticated user's role string |
| `static:VALUE` | A literal value (e.g. `static:published`) |

A caller with no id or no email (an anonymous request, a key or job with no
author) owns no row through `user_id` / `user_email`: the rule hides every
row it covers, on every operator, in the engine and in the database policy.

A key principal is its author to a row rule, so `* created_by eq user_id` keeps
a member's rows private to them through the UI, their API keys and the jobs
they enqueue alike. Only the row rule's value changes: the key's roles are
still `api_key`, and the engine still sees the key as the caller
(`zveltio.user_id`).

### Realtime delivers at most what `GET` serves

For every subscriber and every event, what the WebSocket or SSE stream delivers is at most what
`GET /api/data/:collection/:id` would serve that subscriber at that moment, with the same columns.
When the engine cannot know that, it delivers nothing (ADR 0036).

**The rule for a new kind of row rule.** A new operator or value source is either added to all four
appliers in `lib/tenancy/rule-operators.ts` and to the four-interpreters suite
(`tests/harness/row-rules-four-interpreters.test.ts`), or a collection that uses it cannot be
subscribed to by the readers it binds: a gate that cannot be decided on one record refuses the
subscription, as a query alter does.

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
6. **Rotate secrets after a leak, not on a schedule** - rotating `BETTER_AUTH_SECRET` destroys every API key and TOTP enrolment; follow [the procedure](../platform/security.md#rotating-better_auth_secret)

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
remove that account's factors. That also signs the account out everywhere — a lost
device may still hold a session — so sign in again, then add a passkey from the account
page.

### Session issues

1. Check cookie settings in browser DevTools
2. Verify `BETTER_AUTH_SECRET` is set in `.env`
3. Ensure `BETTER_AUTH_URL` matches your deployment URL
