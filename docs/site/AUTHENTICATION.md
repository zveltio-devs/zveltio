# 🔑 Zveltio Authentication

Complete guide for configuring and using authentication in Zveltio.

---

## Table of Contents

- [Overview](#overview)
- [Email & Password](#email--password)
- [OAuth Providers](#oauth-providers)
- [Two-Factor Authentication (2FA)](#two-factor-authentication-2fa)
- [Session Management](#session-management)
- [God Mode / Emergency Access](#god-mode--emergency-access)
- [API Key Authentication](#api-key-authentication)
- [Auth Endpoints Reference](#auth-endpoints-reference)

---

## Overview

Zveltio uses **Better-Auth** (v1.x) for all authentication. It provides:

- Email/password with bcrypt hashing
- OAuth 2.0 social login (Google, GitHub, Microsoft)
- TOTP-based two-factor authentication
- Session cookies with optional Valkey/Redis secondary storage
- JWT-less — sessions stored server-side

### Required configuration

```env
BETTER_AUTH_SECRET=your-32-char-secret-minimum
BETTER_AUTH_URL=https://api.yourapp.com
```

All auth routes are mounted at `/api/auth/*`.

---

## Email & Password

Enabled by default. No additional configuration needed.

### Sign up

```bash
POST /api/auth/sign-up/email
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword",
  "name": "Full Name"
}
```

Response:
```json
{
  "user": { "id": "...", "email": "user@example.com", "name": "Full Name" },
  "session": { "id": "...", "expiresAt": "..." }
}
```

### Sign in

```bash
POST /api/auth/sign-in/email
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword"
}
```

Sets `better-auth.session_token` cookie on success.

### Sign out

```bash
POST /api/auth/sign-out
```

### Get current session

```bash
GET /api/auth/get-session
```

Returns `null` if not authenticated.

---

## OAuth Providers

OAuth providers are enabled by setting their environment variables. If the variables are absent, the provider is silently skipped.

### Google

```env
GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add authorized redirect URI: `{BETTER_AUTH_URL}/api/auth/callback/google`

### GitHub

```env
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=abc123def456...
```

1. Go to GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. Authorization callback URL: `{BETTER_AUTH_URL}/api/auth/callback/github`

### Microsoft (Entra ID)

```env
MICROSOFT_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MICROSOFT_CLIENT_SECRET=your-client-secret
MICROSOFT_TENANT_ID=common   # or your specific tenant ID
```

1. Go to [Azure Portal](https://portal.azure.com) → Microsoft Entra ID → App registrations
2. New registration → Web redirect URI: `{BETTER_AUTH_URL}/api/auth/callback/microsoft`
3. Certificates & secrets → New client secret

Use `MICROSOFT_TENANT_ID=common` for multi-tenant apps, or your specific tenant ID to restrict to one organization.

### OAuth sign-in flow

```bash
# Initiate (redirect user to)
GET /api/auth/sign-in/social?provider=google&callbackURL=https://app.yourapp.com/dashboard

# Callback handled automatically at:
GET /api/auth/callback/google
```

---

## Magic Link (Passwordless)

Magic link authentication allows users to sign in via an emailed one-time link — no password required.

**Requires:** `SMTP_HOST` environment variable. The feature is silently disabled when SMTP is not configured.

```env
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=no-reply@yourapp.com
SMTP_PASS=yourpassword
SMTP_FROM=no-reply@yourapp.com
APP_DOMAIN=yourapp.com
```

### Request a magic link

```bash
POST /api/auth/magic-link/send
Content-Type: application/json

{ "email": "user@example.com" }
```

The user receives an email with a link valid for **10 minutes**. Clicking the link signs them in and sets a session cookie.

### Sign in via token (SDK)

```typescript
await authClient.signIn.magicLink({ email: 'user@example.com' });
// User receives email — no further action needed in app code
```

---

## Two-Factor Authentication (2FA)

TOTP-based 2FA is enabled by default via the `twoFactor` plugin.

### Enable 2FA for a user

```bash
POST /api/auth/two-factor/enable
# Returns: { totpURI, backupCodes }
```

The `totpURI` can be displayed as a QR code for authenticator apps (Google Authenticator, Authy, 1Password, etc.).

### Verify and activate

```bash
POST /api/auth/two-factor/verify-totp
{
  "code": "123456"
}
```

### Sign in with 2FA

When 2FA is enabled, sign-in returns a `twoFactorRequired` flag:

```bash
POST /api/auth/sign-in/email
→ { "twoFactorRequired": true, "tempToken": "..." }

POST /api/auth/two-factor/verify-totp
{ "code": "123456", "tempToken": "..." }
→ sets session cookie
```

### Disable 2FA

```bash
POST /api/auth/two-factor/disable
{ "password": "current-password" }
```

### TOTP configuration

```typescript
twoFactor({
  issuer: 'Zveltio',   // shown in authenticator app
  totpWindow: 1,        // accept 1 period before/after (30s window each)
})
```

---

## Session Management

Sessions are stored server-side. By default they're in the database; with Valkey configured they're cached in memory for faster lookups.

| Property | Value |
|----------|-------|
| Session duration | 7 days |
| Refresh | Rolling (resets on activity) |
| Cookie name | `better-auth.session_token` |
| Cookie flags | `HttpOnly`, `Secure` (production), `SameSite=Lax` |

### Session cookie with Valkey cache

When `VALKEY_URL` is set, sessions are stored in Valkey (fast reads) and synced to the database. This is recommended for production.

```env
VALKEY_URL=redis://valkey:6379
```

### Verifying sessions in custom routes

```typescript
// Inside a Hono route handler
const session = await auth.api.getSession({ headers: c.req.raw.headers });
if (!session) return c.json({ error: 'Unauthorized' }, 401);

const user = session.user;
// user: { id, email, name, role, ... }
```

---

## God Mode / Emergency Access

God Mode provides an emergency bypass for locked-out administrators. A "god" user has unrestricted access to all resources regardless of Casbin policies.

### Create a god user

```bash
# Via CLI
zveltio create-god

# Prompts for email and password, creates user with role='god'
```

### God user behavior

- Bypasses all Casbin permission checks
- Can access all collections, settings, and admin routes
- Identified by `role='god'` in the user table
- Should only be used for emergency recovery

> **Security note**: Limit god users to 1-2 break-glass accounts. Audit their usage via the Audit Log.

---

## API Key Authentication

API keys provide programmatic access without sessions. They're managed in Studio → API Keys.

### Create an API key

```bash
POST /api/admin/api-keys
Authorization: Bearer <session-token>
{
  "name": "CI/CD Pipeline",
  "expires_at": "2027-01-01T00:00:00Z",  // optional
  "rate_limit": 1000  // requests/minute, optional
}
→ { "key": "zvk_...", "id": "..." }  // key shown only once
```

### Use an API key

```bash
# Option 1: X-API-Key header
GET /api/data/products
X-API-Key: zvk_abc123...

# Option 2: Authorization header
GET /api/data/products
Authorization: Bearer zvk_abc123...
```

### API key limitations

- Cannot access system tables (only `zvd_*` user collections)
- Subject to per-key rate limits
- Automatically revoked after `expires_at`
- Stored as SHA-256 hash — the raw key is shown only at creation

---

## Auth Endpoints Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/sign-up/email` | Register with email/password |
| `POST` | `/api/auth/sign-in/email` | Login with email/password |
| `POST` | `/api/auth/sign-out` | Invalidate current session |
| `GET` | `/api/auth/get-session` | Get current session |
| `GET` | `/api/auth/sign-in/social` | Initiate OAuth flow |
| `GET` | `/api/auth/callback/:provider` | OAuth callback (handled automatically) |
| `POST` | `/api/auth/two-factor/enable` | Enable 2FA — returns TOTP URI |
| `POST` | `/api/auth/two-factor/verify-totp` | Verify TOTP code |
| `POST` | `/api/auth/two-factor/disable` | Disable 2FA |

All endpoints follow the Better-Auth API contract. See [better-auth.com/docs](https://www.better-auth.com/docs) for the full reference.
