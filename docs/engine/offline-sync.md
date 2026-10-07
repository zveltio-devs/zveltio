# Offline Sync — CRDT and Electric SQL

Zveltio's SDK ships two offline-sync strategies. Pick at construction time:

```ts
import { createOfflineProvider } from '@zveltio/sdk/offline';

// Default — CRDT (works against vanilla engine, no extra services)
const sync = await createOfflineProvider({ engineUrl: 'http://localhost:3000' });

// Opt-in — Electric (needs an Electric service the engine can reach)
const sync = await createOfflineProvider({
  engineUrl: 'http://localhost:3000',
  provider: 'electric',
  tables: ['contacts'],
});
const stop = sync.subscribe('contacts', (rows) => render(rows));
```

Both providers implement the same `OfflineProvider` interface — apps migrate from one to the other by changing the `provider` field, with no rewrite of the data layer.

## Picking a provider

| Concern | CRDT | Electric |
|---|---|---|
| Extra services | None | Electric 1.x + a replication slot |
| Direction | Read and write (push/pull) | Read only; writes go through the data API and stream back |
| Replication latency | ~1s (polled) | Long-poll: a change arrives as it commits |
| Rules applied | The engine's read gate | The same gate, compiled into the shape (below) |

The CRDT path is the default because it works against any engine deployment without operator action. Electric fits live views (dashboards, lists other people edit) when the operator is willing to run an extra service.

## How Electric is served

Electric 1.x speaks the HTTP Shape API and reads Postgres as a role that bypasses RLS. So clients never talk to it: Electric has no published port, and every request to it carries `ELECTRIC_SECRET`, which only the engine holds. A client asks the engine:

```
GET /api/electric/v1/shape?collection=contacts&offset=-1
GET /api/electric/v1/shape?collection=contacts&offset=<o>&handle=<h>&live=true&cursor=<c>
```

with a session or an API key, as the data API takes them. The engine then decides the shape itself:

| Shape part | Decided from |
|---|---|
| `table` | The collection, after the caller's Casbin `read` on it (API keys: their scopes). |
| `where` | `tenant_id IN (<the tenants this request reads>)` — the request tenant, a consolidating parent's subtree, or no clause for god, whose reach is every tenant — AND every row rule (`getRlsFilters`), with values as Electric params. |
| `columns` | The table's columns minus those column permissions hide, `search_vector`/`search_text`, and encrypted fields (ciphertext the client cannot use). |

The client may send only `collection`, `offset`, `handle`, `live`, `cursor`, `replica` and `log`; `table`, `where`, `columns`, `params`, `secret` or a `subset__*` query answers `400 electric.param_refused`. The shape is rebuilt on every request, and Electric binds a handle to its shape: a handle used with a different shape — another caller's, or this caller's after a rule or grant changed — answers `409 electric.must_refetch`, and the SDK syncs again from offset `-1`. A revoked `read` answers `403` on the next poll.

### When a collection cannot be served

| Status | Code | Why |
|---|---|---|
| 503 | — | `ELECTRIC_URL` / `ELECTRIC_SECRET` unset. |
| 409 | `electric.unfilterable` | An extension query alter or entity-access rule decides this caller's rows in code, a row rule cannot be expressed, or the collection is virtual. Use CRDT for it. |
| 409 | `electric.columns` | The caller may not read the primary key. |
| 409 | `electric.untenanted` | The table has no `tenant_id`. |
| 409 | `electric.reach_too_wide` | The request reads more than 100 tenants (Electric refuses a request line over ~10 KB). |
| 502 | `electric.upstream` | Electric refused the shape; its message stays in the engine log, since it can quote the WHERE. |

Responses are `Cache-Control: private, no-store`: the same URL is a different shape for another caller, so no shared cache may hold one.

## Operator setup — Electric

```bash
openssl rand -hex 32   # → ELECTRIC_SECRET in .env
docker compose -f docker-compose.yml -f docker-compose.electric.yml up
```

The overlay runs Electric 1.x on the internal network with no published port and sets `ELECTRIC_URL=http://electric:3000` and `ELECTRIC_SECRET` on the engine. Postgres needs `wal_level=logical` (the stack's `db` service has it). Electric manages its own publication and replication slot, and sets `REPLICA IDENTITY FULL` on a table the first time a shape asks for it; nothing is enabled per collection. Its database user needs `REPLICATION`, must own the tables (or be a superuser) and must bypass RLS (superuser or `BYPASSRLS`): the tables are `FORCE ROW LEVEL SECURITY`, and without a tenant setting their policy shows Electric the default tenant only — the shape would sync incomplete, never wider.

An Electric taken down for good must have its slot dropped — `SELECT pg_drop_replication_slot('electric_slot_default')` — or Postgres retains WAL for it without limit. The `zveltio_electric` publication and `zv_electric_enable_table` helpers from migration 001 belong to the 0.12 integration and are unused.

## Falling back to CRDT

The SDK throws `ElectricUnavailable` (with the engine's code and reason) when a shape is refused at creation, and its live loop retries with backoff after a refusal. Switching the client to `provider: 'crdt'` needs no engine change.

## Limits & known gaps

- **Read only.** `push()` on the Electric provider throws; write through the data API.
- **A change of rules takes effect at the next poll.** A long-poll already waiting (up to Electric's `ELECTRIC_LONG_POLL_TIMEOUT`) completes under the shape it started with.
- **Values arrive as Electric serialises them** (text for numbers, Postgres timestamp text), not through the field-type serialisers the data API applies.
