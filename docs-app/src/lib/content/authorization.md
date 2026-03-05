# 🔐 Zveltio Authorization Guide

Complete guide to authentication and authorization in Zveltio, including the God bypass system.

---

## Table of Contents

- [Authentication](#authentication)
- [Authorization](#authorization)
- [God Bypass](#god-bypass)
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
2. **God Bypass** - Special role with unlimited access

### Permission Check Flow

```
Request → Session Verification → God Bypass Check → Casbin Policy Check → Allow/Deny
```

---

## God Bypass

### What is God Mode?

The **God bypass** is a special authorization mechanism that provides unlimited access regardless of Casbin policies. A user with `role='god'` in the database can bypass all permission checks.

### How It Works

In [`packages/engine/src/lib/permissions.ts`](packages/engine/src/lib/permissions.ts):

```typescript
export async function checkPermission(
  userId: string,
  resource: string,
  action: string,
): Promise<boolean> {
  // ═══ HARDCODED GOD BYPASS ═══
  // Independent of Casbin — even if ALL policies are deleted,
  // a user with role='god' will ALWAYS have full access.
  const isGod = await isGodUser(userId);
  if (isGod) return true; // 🚀 Bypass all checks!

  // ... normal Casbin permission check
}
```

### Creating a God User

Use the CLI to create a God user:

```bash
# Create God (super-admin) user
bun run packages/cli/src/index.ts create-god

# Interactive prompts:
# Email: admin@your-company.com
# Name: System Admin
# Password: *********
```

> ⚠️ **Important:** The CLI must set `role: 'god'` in the database, not `'admin'`. This was a bug in previous versions.

### Verify God Status

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

Assign roles via the API:

```bash
# Assign role to user
POST /api/permissions/assign-role
{
  "userId": "user-uuid",
  "role": "admin"
}
```

### Permission Check in Code

```typescript
import { checkPermission } from './lib/permissions.ts';

const canAccess = await checkPermission(userId, 'products', 'read');
if (!canAccess) {
  return c.json({ error: 'Forbidden' }, 403);
}
```

---

## API Security

### Rate Limiting

Zveltio includes rate limiting to prevent abuse:

```typescript
// Default limits
- API: 100 requests/second
- Auth endpoints: 5 requests/minute
```

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

Zeltio uses **Kysely** with parameterized queries:

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
3. **Limit God users** - Only create one God user for emergency access
4. **Review permissions** - Regularly audit Casbin policies
5. **Use HTTPS** - Always use SSL/TLS in production
6. **Rotate secrets** - Change `BETTER_AUTH_SECRET` periodically

---

## Troubleshooting

### "Permission denied" errors

1. Check user role in database: `SELECT role FROM "user" WHERE email = '...'`
2. Verify Casbin policies: `SELECT * FROM zvd_permissions`
3. If user should have God access, update role: `UPDATE "user" SET role = 'god' WHERE email = '...'`

### Cannot create God user

1. Ensure database is running
2. Check database connection in `.env`
3. Verify Better-Auth is initialized: `bun run -T packages/engine/src/db/migrate.ts`

### Session issues

1. Check cookie settings in browser DevTools
2. Verify `BETTER_AUTH_SECRET` is set in `.env`
3. Ensure `BETTER_AUTH_URL` matches your deployment URL
