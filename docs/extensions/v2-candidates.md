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
