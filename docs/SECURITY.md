# 🔒 Zveltio Security Guide

Security best practices and hardening guide for Zveltio.

---

## Table of Contents

- [Security Overview](#security-overview)
- [Authentication Security](#authentication-security)
- [Authorization & RBAC](#authorization--rbac)
- [API Security](#api-security)
- [Database Security](#database-security)
- [Network Security](#network-security)
- [Security Checklist](#security-checklist)

---

## Security Overview

Zveltio implements **defense in depth** security with multiple layers:

```
┌─────────────────────────────────────────┐
│  Layer 1: Network (Firewall, SSL/TLS)  │
├─────────────────────────────────────────┤
│  Layer 2: Application (Rate Limiting)  │
├─────────────────────────────────────────┤
│  Layer 3: Authentication (Better-Auth)  │
├─────────────────────────────────────────┤
│  Layer 4: Authorization (Casbin RBAC)    │
├─────────────────────────────────────────┤
│  Layer 5: Emergency Admin Access         │
├─────────────────────────────────────────┤
│  Layer 6: Database (Encryption, RLS)     │
├─────────────────────────────────────────┤
│  Layer 7: Audit (Logging, Monitoring)   │
└─────────────────────────────────────────┘
```

**Security Principles:**

- ✅ Least Privilege Access
- ✅ Zero Trust Architecture
- ✅ Defense in Depth
- ✅ Fail Secure (not fail open)
- ✅ Security by Default

---

## Authentication Security

### Password Security

**Requirements enforced:**

```typescript
// Password must have:
- Minimum 8 characters
- At least 1 uppercase letter
- At least 1 lowercase letter
- At least 1 number
- At least 1 special character

// Passwords are hashed using bcrypt
```

### Session Security

```typescript
// Session configuration (Better-Auth)
{
  sessionMaxAge: 7 * 24 * 60 * 60, // 7 days
  sessionUpdateAge: 24 * 60 * 60,  // Refresh daily
  sessionCookie: {
    httpOnly: true,        // ✅ Prevent XSS
    secure: true,         // ✅ HTTPS only
    sameSite: 'strict',   // ✅ CSRF protection
    path: '/'
  }
}
```

### Environment Variables

```bash
# Authentication - CRITICAL
BETTER_AUTH_SECRET=CHANGE_ME_64_RANDOM_CHARACTERS
BETTER_AUTH_URL=https://api.yourdomain.com
```

### Two-Factor Authentication (2FA)

**Enable 2FA for:**

- ✅ All admin users (REQUIRED)
- ✅ All users with sensitive data access

---

## Authorization & RBAC

### Casbin Policies

**Default Secure Policies:**

```csv
# p, subject, resource, action, scope
p, admin, *, *, ALL
p, manager, data, read, ORGANIZATION
p, manager, data, write, DEPARTMENT
p, employee, data, read, OWN
```

### Emergency Admin Access

Zveltio has a special **Emergency Admin Access** mechanism for emergency access:

```typescript
// In permissions.ts - checked BEFORE Casbin
const isGod = result.rows[0]?.role === 'god';
if (isGod) return true; // Emergency Admin bypass — all permission checks skipped!
```

> **Note:** This mechanism is equivalent to Supabase's `service_role` key and Directus's admin token. It provides a fail-safe guarantee that administrators cannot be permanently locked out through misconfiguration.

**⚠️ Security Warning:**

- Only create ONE Emergency Admin (Super-Admin) user for emergency access
- Use the Emergency Admin account only when absolutely necessary
- Monitor Emergency Admin activity closely

### Hardening

- ❌ Never grant `ALL` scope to non-admin users
- ✅ Use specific scopes (ORGANIZATION, DEPARTMENT, OWN)
- ✅ Review permissions quarterly
- ✅ Implement approval workflows for sensitive actions

---

## API Security

### Rate Limiting

Default limits:

- **API:** 100 requests/second
- **Auth endpoints:** 5 requests/minute

### CORS Configuration

```typescript
// NEVER use wildcard in production
app.use(
  '*',
  cors({
    origin: ['https://studio.yourdomain.com', 'https://app.yourdomain.com'],
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);
```

### Input Validation

```typescript
import { z } from 'zod';

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100),
  password: z
    .string()
    .min(8)
    .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
});
```

### SQL Injection Prevention

Zveltio uses **Kysely** (parameterized queries):

```typescript
// ✅ SAFE - Parameterized
await db.selectFrom('users').where('email', '=', userInput).execute();

// ❌ NEVER DO THIS
await sql.raw(`SELECT * FROM users WHERE email = '${userInput}'`);
```

---

## Database Security

### Connection Security

```bash
# Use SSL for database connections
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true
```

### Connection Pooling with PgBouncer

```ini
# pgbouncer.ini
[databases]
zveltio_prod = host=postgres port=5432 dbname=zveltio_prod

[pgbouncer]
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 25
auth_type = scram-sha-256  # ✅ Secure auth
```

### Access Control

```sql
-- Application user (limited permissions)
CREATE USER zveltio_app WITH PASSWORD 'strong_password';
GRANT CONNECT ON DATABASE zveltio_prod TO zveltio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO zveltio_app;

-- Admin user (full access)
CREATE USER zveltio_admin WITH PASSWORD 'different_strong_password';
GRANT ALL PRIVILEGES ON DATABASE zveltio_prod TO zveltio_admin;
```

### Row-Level Security (RLS)

```sql
-- Enable RLS on sensitive tables
ALTER TABLE zvd_user_data ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own data
CREATE POLICY user_isolation ON zvd_user_data
  USING (user_id = current_setting('app.current_user_id')::uuid);
```

---

## Network Security

### Firewall Configuration

```bash
# Allow only necessary ports
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP
ufw allow 443/tcp  # HTTPS
ufw enable
```

### SSL/TLS

Always use HTTPS in production:

```bash
# Use Let's Encrypt
CERTBOT_AUTO_RENEW=true
```

---

## Security Checklist

### Before Production

- [ ] Change `BETTER_AUTH_SECRET` to a strong 64-character random string
- [ ] Enable SSL/TLS with valid certificates
- [ ] Configure CORS to whitelist specific domains
- [ ] Enable 2FA for all admin users
- [ ] Set up database user with minimal permissions
- [ ] Configure firewall to allow only necessary ports
- [ ] Set up monitoring and alerting
- [ ] Create backup strategy

### Ongoing

- [ ] Review logs weekly
- [ ] Rotate secrets quarterly
- [ ] Update dependencies monthly
- [ ] Review user permissions monthly
- [ ] Test backups quarterly

---

## Incident Response

If you suspect a security incident:

1. **Immediately** change all passwords
2. **Check** logs for suspicious activity
3. **Disable** affected user accounts
4. **Contact** security team
5. **Document** the incident

---

## Learn More

- [Authorization Guide](docs/AUTHORIZATION.md)
- [Installation Guide](docs/INSTALLATION.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
