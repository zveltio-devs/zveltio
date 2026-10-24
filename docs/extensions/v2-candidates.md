# extension-api v2 candidates

extension-api v1 is frozen ([authoring.md](authoring.md#the-v1-contract-is-frozen)):
it only grows, additively, until v2 ships before GA. Then extensions migrate
and v1 is removed.

This page collects what v1 taught us, so v2 is designed from it rather than
from memory. Two kinds of entry:

- **Breaking** — a change v1's freeze forbids; it waits for v2.
- **Stopgap** — something added to v1 additively because it was needed now,
  in a shape v2 should replace or own properly.

Each entry says what happened, what v1 does now, and what v2 should do.

## 1. Cross-replica broadcast — stopgap (3.0.0-beta.90)

**What happened.** `ai` caches each firm's providers in memory. Saving a
provider dropped the cache on the replica that served the request only; every
other replica kept the old providers until it restarted. Extensions had no way
onto the realtime bus the engine uses for its own caches.

**What v1 does.** `ctx.broadcast` — an optional member of the register-style
`ExtensionContext`, inline extensions only:
`publish(name, data?)`, `on(name, handler)`, `onMissed(handler)`. The engine
owns the envelope (one bus event, the extension's name, its current tenant),
delivers to every replica including the publisher after the commit, runs each
handler in the publisher's tenant transaction, refuses a message over the
pg_notify limit at `publish`, and calls `onMissed` when a replica's bus
reconnects. A worker-isolated extension is refused it by name.

**What v2 should do.**

- Put it on the v2 host (the action/job `host`, or whatever replaces
  `register(app, ctx)`), not on the legacy context.
- Carry it across the runner protocol, so a worker-isolated extension can use
  it too.
- Declare messages in the manifest (name, payload schema), so the engine can
  validate `data` and a review can see what an extension sends.
- Decide whether invalidation should be a first-class, declarative cache
  (`host.cache(key, load)` with engine-owned invalidation across replicas)
  instead of a message an extension has to remember to send.
- A publisher whose own send fails (the bus down at `publish`) only logs; no
  receiver learns of it. v2 should say what delivery it guarantees.

## 2. API-key `execute` is per extension — breaking

**What happened.** A key's scopes name resources. For an extension the
resource is `$ext:<name>`, so `execute` on it admits every manifest action of
the extension whose permission action is `execute`. A key meant for one action
(send an invoice) can run all of them (cancel, storno, …).

**What v1 does.** Keeps the per-extension scope, documented in
[developer-guide.md](developer-guide.md). An extension that needs a narrower
key gives the action its own permission action (`approve`, `storno`) and the
key names that action. Studio's API-key page offers only `execute`; a custom
permission action is typed into the scope by hand.

**What v2 should do.**

- Address an action as a resource of its own (`$ext:<name>/<action>`, or the
  manifest action id), so a key, the permission matrix and an audit row all
  name the same thing.
- List extension actions in `GET /api/admin/resources`, so the matrix and the
  API-key page can offer them instead of free text.
- Decide whether `$ext:<name>` with `execute` keeps meaning "every action"
  (a wildcard) or is refused once per-action resources exist.

## 3. Free-string extension objects — breaking

**What happened.** Collections and extension objects share one bare Casbin
namespace. Manifest `resources` let an extension invent object names, so a
collection created under one of those names inherited the extension's grants,
and its drop had to guess which rules were the collection's (`since`,
`keepGrants`, `nonCollectionObjects`, `adopt_rules`). Under
[RFC v3](../engine/rfc-extension-model-v3.md) extensions only declare
collections and actions, and a bare object is a collection, apart from the
engine objects `admin`, `data`, `$edge` and `*`.

**What v1 does.** Keeps `resources`, `sensitiveResources` and
`ctx.checkPermission` on any string. Additively, an action's
`permission.resource` may also name a collection the manifest's actions or
jobs read or write. The engine grants `execute` on it once the collection
exists, and the grant goes with the collection. So an extension can leave
`resources` behind before v2.

**What v2 should do.**

- Remove manifest `resources` and `sensitiveResources`, and decide how an
  extension withholds one of its collections from the default grants.
- Remove `ctx.checkPermission` on a free string. A check names a collection
  the extension declares, or an engine object through `host.*`.
- Then refuse a rule on anything that is not `*`, an engine object or an
  existing collection, let a drop delete all of the collection's rules, and
  delete the machinery that guesses (`since`, `keepGrants`,
  `nonCollectionObjects`, `adopt_rules`).
