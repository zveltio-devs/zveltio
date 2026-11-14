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

- Remove manifest `resources` and `sensitiveResources`. An extension withholds
  one of its declared collections from the default grants with
  `"defaultGrants": false` in the collection's schema file (shipped 2026-10-29).
- Remove `ctx.checkPermission` on a free string. A check names a collection
  the extension declares, or an engine object through `host.*`.
- Then refuse a rule on anything that is not `*`, an engine object or an
  existing collection, let a drop delete all of the collection's rules, and
  delete the machinery that guesses (`since`, `keepGrants`,
  `nonCollectionObjects`, `adopt_rules`).

**Decided 2026-10-25.** Pre-GA there are no installs and no external
extension authors, so this entry does not wait for a separate v2: it ships
with the official extension migration wave, which moves every first-party
manifest to collections and actions. Ownership then becomes a column the
engine writes when it creates a declared collection, so nothing has to infer
it from a manifest. Entry 4 ships with it.

**Status 2026-11-10.** The wave is done. The engine refuses a rule on
anything that is not `*`, an engine object, a registered extension's
`$ext:<name>` or an existing collection (migration 116), a drop deletes all of
the collection's rules, and `since`, `keepGrants`, `nonCollectionObjects` and
`adopt_rules` are deleted (ADR 0002 step 5). Still open: the manifest schema
still accepts `resources` and `sensitiveResources` (a `resources` entry that is
no collection now gets no grant), and entry 4's refusal.

## 4. An action gated on a collection the extension does not own — breaking

**What happened.** Entry 3's additive rule lets an action's
`permission.resource` name any collection the manifest's actions or jobs read
or write. Reading or writing a collection is not owning it: an extension can
gate an action on a collection another extension or an operator created, and
the engine then grants the default `execute` there to `tenant_member`. v1 has
no signal for ownership. `contributes.collections` exists in the manifest
schema, but no extension sets it, and "writes only" would wrongly withhold the
grant from a read-only action (a report) on the extension's own collection.

**What v1 does.** Grants the default `execute` on any collection an action is
gated on and the manifest reads or writes, as entry 3 describes. Pre-GA, with
no external installs, the exposure is an action of the extension itself.

**What v2 should do.** Under
[RFC v3](../engine/rfc-extension-model-v3.md) an extension declares its
collections through schema-as-code and the engine creates them, so the engine
knows the owner. Require an action's `permission.resource` to be a collection
the extension declares, refuse the manifest otherwise, and grant the default
`execute` only there.

## 5. `storage` hands an extension the instance's S3 keys — breaking

**What happened.** The `storage` capability puts the instance's object-storage
settings in `ctx.config.objectStorage`, access key and secret included. With
them an extension reads and writes the whole bucket directly, past every rule
the engine's storage routes enforce: tenancy, the private and public
namespaces. Nothing limited the capability to first-party code: a third party
that declared it and got operator consent received the keys, in its worker too
(the init message clones the config).

**What v1 does.** Narrowed now, an owner exception to the freeze (2026-11-07),
like entries 3 and 4: the keys go only to a first-party extension, and anyone
else reads `undefined`, as on an instance without object storage. First-party
is the tier the publisher-tier gate verified (the extension runs inline), not
its name. The only declarer is `storage/cloud`.

**What v2 should do.** Move `storage/cloud` onto an engine file API that applies
the engine's storage rules, then retire the `storage` capability and
`ctx.config.objectStorage`: no extension holds instance credentials.

## 6. The legacy `ZVELTIO_EXT_<NAME>_<KEY>` spelling — breaking

**What happened.** `ctx.config.vars` read `ZVELTIO_EXT_<NAME>_<KEY>`, with no
delimiter between name and key, so one variable spells two extensions' settings
(`ZVELTIO_EXT_BILLING_STRIPE_WEBHOOK_SECRET` is `billing`'s `STRIPE_WEBHOOK_SECRET`
and `billing-stripe`'s `WEBHOOK_SECRET`). #1597 withholds such a key from both,
judged against the extensions the process knows at load, which cannot cover an
overlapping extension installed after the first one loaded.

**What v1 does.** ADR 0030 adds `ZVELTIO_EXT_<NAME>__<KEY>`: the last `__` ends
the name and the key has none, so a variable names one extension whatever else
is installed. The legacy spelling is still read, logged at load with its new
name, and loses to the delimited one; a variable with `__` after
`ZVELTIO_EXT_` is never read as a legacy key.

**What v2 should do.** Stop reading the single-underscore spelling, and drop the
withholding logic that exists only for it.

## 7. `forwardCredentials` matches a path for every method — narrowing

**What happens.** A `forwardCredentials` entry is keyed by a `publicRoutes`
path, so an approved header reaches every method on that path: approving
`authorization` for `POST /scim/*` forwards it to `DELETE /scim/*` too. No
first-party extension uses `forwardCredentials` (checked 2026-11-14).

**What v1 does.** Nothing (ADR 0048, owner 2026-11-14): restricting it by method
narrows what an approved manifest forwards, and narrowings wait for v2.

**What v2 should do.** Carry the forwarded headers on the declared route entry
(ADR 0039), which already names its method, and drop the path-keyed map.
