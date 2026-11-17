# HTTP API compatibility

What a client can rely on across engine releases. Decided in ADR 0055.

## The API is version 1 for the whole 3.x line

The paths are `/api/...`, with no version segment and no version header. The
HTTP API version is the engine's **major**: engine 3.x serves API version 1,
and a breaking change to a contract route ships only in an engine major. One
engine serves one API version.

The OpenAPI document (`GET /api/openapi.json`) says it in `info.x-api-version`
(`1`). Responses carry no version header.

## What counts as breaking

**Breaking — only in a major:**

- removing or renaming a route, a field, a query parameter or an enum value a
  client reads;
- a field changing type or nullability;
- a success status changing;
- a request that succeeded being refused (except a security fix, below);
- a default changing what a client receives.

**Not breaking — any release:**

- a new route, a new optional request field, a new response field;
- a new value in an enum documented as open;
- a new `problem+json` `type`;
- refusing input that was never documented as accepted;
- any change made to close a security hole. The changelog says so.

## Deprecation and removal

A route or behaviour to be removed is marked `deprecated: true` in the OpenAPI
document and answers with a `Deprecation` header (RFC 9745) and, once the
removal release is known, a `Sunset` header (RFC 8594), for at least one minor
before the major that removes it. After removal it answers **410** naming its
replacement for the whole next major, then disappears.

## Which groups the contract covers

**Inside the contract:** `/api/auth`, `/api/sign-in`, `/api/me`, `/api/data`,
`/api/actions`, `/api/collections`, `/api/relations`, `/api/schema`,
`/api/storage`, `/api/realtime`, `/api/ws`, `/api/revisions`,
`/api/validation`, `/api/rpc`, `/api/users`, `/api/invitations`,
`/api/tenants`, `/api/permissions`, `/api/api-keys`, `/api/settings`,
`/api/notifications`, `/api/webhooks`, `/api/backup`, `/api/admin`,
`/api/health`, `/api/openapi.json`, `/api/extensions`.

**Outside the contract** — may change or leave in any release; their OpenAPI
paths carry `x-contract: none`:

- `/api/flows`, `/api/edge-functions`, `/api/fn`, `/api/sync`, `/api/electric`;
- `/api/saved-queries` (leaving the engine);
- `/api/erd` (Studio's own diagram positions);
- `/api/marketplace` (the operator's install path, moving with the registry);
- every route already gone and answering 410: `/api/insights`,
  `/api/admin/sql`, `/api/templates`,
  `/api/approvals`, `/api/export`, `/api/import`, `/api/media`,
  `/api/briefing`;
- `/ext/*`: an extension route's contract is the extension's own version, not
  the engine's.

The list lives in `API_GROUPS` (`packages/engine/src/routes/openapi.ts`). A unit
test fails when the engine mounts an `/api` group that list does not classify,
so a new group cannot enter the contract silently.

## Numbers in responses

`bigint` and `numeric` columns — the `integer`, `number` and `decimal` field
types — are answered as exact JSON strings, never as JSON numbers that would
lose digits. A write accepts a number or a numeric string. Generated types
declare these fields `number | string`. This is the 3.x contract.
