# Troubleshooting

Common issues and solutions for Zveltio.

## Installation Issues

### Docker services won't start

> **Error:** Container fails to start or exits immediately

```bash
# Check container logs
docker compose logs engine

# Check if ports are already in use
netstat -ano | findstr "3000"
```

### Bun not found

> **Error:** `bun: command not found`

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Verify installation
bun --version
```

## Database Issues

### Database connection refused

> **Error:** `connect ECONNREFUSED 127.0.0.1:5432`

```bash
# Check if PostgreSQL is running
docker compose ps db

# Start the database
docker compose up -d db

# Check database logs
docker compose logs db
```

### Connection pool exhausted

> **Warning:** Remaining connection slots are reserved

```bash
# Check active connections
docker compose exec db psql -U zveltio -d zveltio -c "SELECT count(*) FROM pg_stat_activity"
```

If connections are high, check for connection leaks in your application code. PgDog is configured by default to pool connections — ensure `DATABASE_URL` points to PgDog on port `6432`, not directly to PostgreSQL on `5432`.

## Authentication Issues

### Session expired

> **Warning:** Session token is invalid or expired

- Check that `BETTER_AUTH_SECRET` in `.env` is at least 32 characters long.
- Clear browser cookies and try again.
- Ensure the secret has not changed between restarts (changing it invalidates all sessions).

### Cannot create God user

> **Error:** Failed to create God user

```bash
# Make sure database is running
docker compose up -d db pooler

# Run migrations first
bun run -T packages/engine/src/db/migrate.ts

# Then create God user
bun run packages/cli/src/index.ts create-god
```

### Permission denied errors

> **Error:** Forbidden - insufficient permissions

```bash
# Check user role in database
docker compose exec db psql -U zveltio -d zveltio \
  -c 'SELECT id, email, role FROM "user"'

# Update user role to god if needed
docker compose exec db psql -U zveltio -d zveltio \
  -c "UPDATE \"user\" SET role = 'god' WHERE email = 'admin@example.com'"
```

### Accounts that share an address in another case

> **Warning at boot:** `user_email_lower_key is not built: … belong to more than one account`
> — and `email_uniqueness` failing in `GET /api/health/deep`.

Migration 048 makes an address unique whatever its case (`Ana@x.ro` is
`ana@x.ro`). An install that already held two such accounts — usually one made
by an SSO, LDAP or SCIM login with the identity provider's spelling — cannot
build that index, so the migration skips it and the engine keeps running. Until
it is built, another account can still be created next to an existing one in a
different case.

Which account is the real one is your decision. The engine does not merge
identities: guessing wrong hands one person's account to another.

Until they are merged, a lookup by address (sign-in, password reset, magic link,
the admin routes) takes the account stored in exactly the spelling looked up —
for sign-in that is the all-lowercase one, since better-auth lowercases what is
typed. When no twin holds that exact spelling, the address matches no account
and the engine logs `matches several accounts in another case and none exactly`.

```sql
-- 1. The twins, oldest first in each group.
SELECT lower(email) AS address, id, email, "createdAt",
       (SELECT count(*) FROM session s WHERE s."userId" = u.id) AS sessions
  FROM "user" u
 WHERE lower(email) IN (SELECT lower(email) FROM "user" GROUP BY 1 HAVING count(*) > 1)
 ORDER BY 1, "createdAt";
```

2. For each twin you are not keeping, move what it owns to the kept account if
   you need it, then delete it with `DELETE /api/users/<id>` (or from Studio),
   which also removes its permission grants.

```sql
-- 3. Build the index without blocking writes. If it fails, a twin is left:
--    DROP INDEX CONCURRENTLY user_email_lower_key; and go back to step 1.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS user_email_lower_key ON "user" (lower(email));
```

The boot warning and the health check clear once the index is valid.

## Performance Issues

### Slow API responses

> **Symptom:** API requests take more than 1 second

1. Check database query performance via `EXPLAIN ANALYZE` on slow queries
2. Monitor Valkey cache hit rate (visible at `/metrics`)
3. Review Prometheus metrics at `/metrics`
4. Check disk I/O — SeaweedFS can become a bottleneck on spinning disks

### High memory usage

> **Symptom:** Engine uses more than 2GB RAM

```bash
# Check memory usage per container
docker stats

# Restart engine to clear memory
docker compose restart engine
```

If memory grows over time, check for large in-memory caches (Casbin rule cache, extension registry) or memory leaks in extensions.

## Deployment Issues

### SSL certificate errors

> **Error:** SSL certificate verification failed

```bash
# Check certificate expiration
openssl s_client -connect yourdomain.com:443 -showcerts

# Renew Let's Encrypt certificate
docker compose restart nginx
```

### Webhook delivery failures

> **Symptom:** Webhooks not reaching destination

1. Check webhook delivery logs in Studio under **Webhooks → Logs**
2. Verify destination server is reachable from the engine container
3. Check that the webhook secret matches on both sides
4. Review retry settings — failed webhooks retry up to 5 times with exponential backoff

## Getting Help

If you're still experiencing issues:

1. Check [GitHub Issues](https://github.com/zveltio-devs/zveltio/issues) for known problems
2. Search existing discussions for similar symptoms
3. Open a new issue with: Zveltio version, Docker logs (`docker compose logs`), and steps to reproduce
