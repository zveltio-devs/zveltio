# Tenant isolation, door by door

A tenant sees nothing of another tenant. The rule is enforced by PostgreSQL
(`FORCE ROW LEVEL SECURITY`, keyed on the request's tenant; see
[multi-tenancy.md](multi-tenancy.md)), not by each route remembering a filter.
This page lists the ways in, the *doors*, and how each one is proved.

The proof is one test file,
`packages/engine/src/tests/harness/tenant-isolation-doors.test.ts`, which runs in
CI with the harness lane. It holds a table with one row for **every route under
the prefixes that serve tenant data**. A route added under one of those prefixes
without a row fails the suite, so a new door cannot ship unexamined.

The prefixes are `/api/data`, `/api/sync`, `/api/realtime`, `/api/ws`,
`/api/revisions`, `/api/storage`, `/files`, `/api/api-keys`, `/api/webhooks`,
`/api/flows`, `/api/insights`, `/api/saved-queries`, `/api/notifications` and
`/api/rpc`.

## How a door is probed

Two real tenants, A and B. A member of each writes rows through the API. Then
links between them are forged in the database: an A row naming a B row, the
shape an expansion or a join would leak through. Every probe runs as a member
of A and looks for B's marker in whatever comes back. The writes are checked
against the database afterwards.

A mutation check, made when the suite was written: with row-level security
switched off on one table, five of the probes fail.

## Proved in the suite

| Door | What is asserted |
|---|---|
| `GET /api/data/:collection` | List, `?search=`, `?filter=`, the total count and `?as_of=` time travel show nothing of B |
| `?expand=` on list and single reads | An m2o, o2m and m2m link into B expands to nothing |
| `GET` / `PATCH` / `PUT` / `DELETE /api/data/:collection/:id` | B's row is not found, and is left unchanged |
| `POST /api/data/:collection` and `/bulk` | A create lands in the request's tenant, whatever `tenant_id` the body names |
| `PATCH` / `DELETE /api/data/:collection/bulk` | B's ids are not reached |
| API key scoped to A | Reads A only, and is refused in B |
| `POST /api/sync/pull` / `push` | A pull carries nothing of B, and a push does not change B's row |
| `GET /api/ws`, `GET /api/realtime/stream` | A write in B reaches no socket and no stream in A, while a write in A does |
| `GET /api/revisions/:id`, `POST …/revert` | B's revision is refused, and reverting it changes nothing |
| Record comments (read, write, delete) | B's comments are not read; A cannot write into, or delete from, B's |
| `GET /api/storage/:id/signed-url`, `/transform` | No URL and no image for B's file |
| `GET` / `POST /api/storage/folders` | B's folders are not listed; a folder lands in its own tenant |

## Proved by a dedicated test

Each of these test files creates a row in another tenant and asserts that it is
absent or refused:

| Doors | Test |
|---|---|
| `/api/api-keys` list, create, revoke | `api-keys-tenant-isolation.test.ts` |
| `/api/webhooks` list, create, read, change, delete, rotate; the dispatcher | `webhooks-tenant-isolation.test.ts` |
| `/api/flows` list, create, read, change, delete, run, runs | `flows-tenant-isolation.test.ts` |
| `/api/insights/dashboards` list, create, read, delete | `dashboards-tenant-isolation.test.ts` |
| `/api/insights/saved-queries` list | `insights-role-share-visibility.test.ts` |
| `/api/saved-queries` list, read | `saved-queries-import-tenant-isolation.test.ts` |
| `/api/storage` list, read, delete | `storage-tenant-isolation.test.ts` |
| `/api/revisions` list | `revisions-tenant-isolation.test.ts` |
| `/api/realtime/presence`, `/broadcast` | `realtime-channel-routes.test.ts` |
| `POST /api/notifications/broadcast` | `tenant-membership-validity.test.ts` |

## Not a tenant door

- **Per user.** The notification inbox and push-token routes serve only the
  caller's own rows.
- **No tenant data.** The rate-limit and preview middlewares under `/api/data/*`
  and `/api/sync/*` have no handler. `/api/ws/info` describes the endpoint. The
  VAPID key is the instance's public key. `/api/api-keys/self` returns the
  presenting key itself.
- **Instance administrators only.** `/api/insights/stats`.

## Not yet in the suite

These routes are listed in the table as `todo`, each with the assertion its
probe has to make. They are tenant-scoped in the code, but no test proves it yet:
- connection and stats endpoints of realtime;
- `POST /api/realtime/publish`;
- storage upload and `/files/*`;
- API-key rate limits;
- webhook deliveries, test and dead letters;
- flow steps and dead letters;
- dashboard shares and panels;
- ad-hoc and saved queries (writes and executions);
- insights subscriptions;
- RPC functions.

Moving a row from `todo` to `here` means writing its probe.
