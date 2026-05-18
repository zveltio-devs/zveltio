# Offline Sync — CRDT and Electric SQL

Zveltio's SDK ships two offline-sync strategies. Pick at construction time:

```ts
import { createOfflineProvider } from '@zveltio/sdk/offline';

// Default — CRDT (works against vanilla engine, no extra services)
const sync = await createOfflineProvider({ engineUrl: 'http://localhost:3000' });

// Opt-in — Electric SQL (needs Electric service alongside Postgres)
const sync = await createOfflineProvider({
  engineUrl: 'http://localhost:3000',
  provider: 'electric',
});
```

Both providers implement the same `OfflineProvider` interface — apps migrate from one to the other by changing the `provider` field, with no rewrite of the data layer.

## Picking a provider

| Concern | CRDT | Electric |
|---|---|---|
| Extra services | None | Electric service + replication slot |
| Conflict resolution | Field-level Last-Write-Wins | CRDTs implemented in Electric |
| Replication latency | ~1s (polled) | <100 ms (websocket) |
| Schema migrations | Free (SDK-side) | Requires `REPLICA IDENTITY FULL` + publication membership |
| Network overhead | Polling pull/push | Continuous websocket |

The CRDT path is the default because it works against any engine deployment without operator action. Electric is the right choice when sync latency matters (collaborative editing, live dashboards) and the operator is willing to run an extra service.

## Operator setup — Electric

### 1. Run the migration

Migration `075_electric_replication.sql` creates the `zveltio_electric` publication + helper functions. The engine auto-applies migrations on startup; no manual SQL.

### 2. Generate a shared secret

```bash
openssl rand -hex 32
```

Add it to your `.env`:

```
ELECTRIC_URL=ws://electric:5133
ELECTRIC_AUTH_TOKEN=<the secret you just generated>
```

The engine signs short-lived (60 s) HS256 JWTs with this secret; Electric verifies them with the same secret. The secret never leaves these two trusted environments.

### 3. Stand up Electric alongside Postgres

```bash
docker compose -f docker-compose.yml -f docker-compose.electric.yml up
```

The overlay starts Electric, wires its env, and injects `ELECTRIC_URL` / `ELECTRIC_AUTH_TOKEN` into the engine container.

### 4. Enable replication per collection

Electric only replicates tables explicitly added to its publication. Call the helper function once per collection you want to sync:

```sql
SELECT zv_electric_enable_table('zvd_contacts');
```

The function sets `REPLICA IDENTITY FULL` (so updates carry the full prior row) and adds the table to `zveltio_electric`. Safe to call repeatedly.

To remove a table from sync:

```sql
SELECT zv_electric_disable_table('zvd_contacts');
```

## How the auth flow works

1. Client calls `POST /api/electric/auth` (with the better-auth session cookie).
2. Engine validates the session, mints `{ sub: user.id, tenant_id, exp: now+60, aud: 'electric-sql' }` HS256-signed with `ELECTRIC_AUTH_TOKEN`.
3. Engine returns `{ token, expiresAt, electricUrl }`.
4. Client connects to `${electricUrl}?token=<jwt>`. Electric verifies the signature against the same shared secret.
5. Before the token expires, the SDK requests a fresh one (background timer; no user action).

The shared secret is HMAC-symmetric: anyone holding it can mint tokens. Keep it server-side only.

## Falling back to CRDT

If `ELECTRIC_URL` is unset on the engine, `/api/electric/auth` returns 503 with a structured error. The SDK throws `ElectricUnavailable`. Operators can switch the client back to `provider: 'crdt'` without a redeploy of the engine.

## Limits & known gaps

- **Token revocation** isn't supported — the 60-s TTL is the only revocation mechanism. For high-security tenants, shorten `TOKEN_TTL_SECONDS` in `routes/electric.ts`.
- **Per-row authorization** isn't enforced by the JWT — Electric replicates whatever's in the publication. Use Postgres RLS on the tables themselves if you need row-level visibility rules.
- **The current SDK Electric driver** speaks a minimal subset of Electric's protocol (auth + change + subscribe). The full `electric-sql` JS client lands once Electric publishes a stable browser bundle for the v1 protocol.
