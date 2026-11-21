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

**When v2 freezes.** On evidence, not on a date. Three proof apps are built
from the public documentation and the published packages only, with no access
to engine or extension source: one on a database adopted with `byod`, one with
a job that makes an external call, and one free choice. Every detour is a
finding, and every finding that needs a breaking change becomes an entry here.
v2 freezes when the last run adds no breaking entry.

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

**What v2 should do** (amended by ADR 0058 decision 5, 2026-11-17).

- Name an action only inside an API key's `$ext:<name>` scope entry (for
  example `{ collection: "$ext:invoicing", actions: ["send"] }` naming the
  manifest action). An action is never a Casbin object of its own and never
  appears in `GET /api/admin/resources`: ADR 0002 keeps the engine objects
  closed, and ADR 0015 already refused the action-as-object option.
- Decide whether `$ext:<name>` with `execute` keeps meaning "every action"
  (a wildcard) or is refused once actions can be named in the scope.
- Job subjects (`apikey:job:<ext>:<job>`) stay an accepted exception: they
  are minted by the engine for a declared job and gated by the job's declared
  capabilities, not by an admin-written scope.

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

## 8. `addField` inside an open request builds a unique key under the lock — narrowing

**What happens.** A `unique` field added by the engine's own routes builds its
key with `CREATE UNIQUE INDEX CONCURRENTLY`, so the table keeps taking writes
(DR-37). An extension that calls `addField` inside a request it holds open
cannot do that: a concurrent build would wait on the request's own virtual
transaction id and deadlock. So the key is built in the request's transaction,
and the table refuses writes while it is built (about 400 ms per million rows).

**What v1 does.** Nothing (owner, 2026-11-15): refusing a `unique` `addField`
inside an open request narrows what v1 accepts, and narrowings wait for v2.

**What v2 should do.** Refuse a `unique` field added inside an open request,
or take it out of the request: the engine builds the key after the request
commits, as the routes do.

## 9. `"*"` in an action is first-party only — narrowing

**What happened.** ADR 0047 let an action list `"*"` in `reads` / `writes` and
reach any collection as its caller, consented as `collections:any:read` /
`collections:any:write`. A third-party extension holding that consent reaches
every collection the person running it can, which is more than any review of
its manifest can bound.

**What v1 does.** Narrowed now, an owner exception to the freeze (ADR 0053
decision 5, 2026-11-15), like entries 3, 4 and 5: an extension may list `"*"`
only when the publisher-tier gate verified it first-party, never by its name.
Any other extension listing it is refused at load with a `lastLoadError`
naming the action. A worker-isolated extension never has its tier looked up,
so it is never first-party here. No external author used `"*"`; the
first-party users are `analytics/quality`, `content/drafts` and
`integrations/migrators`.

**What v2 should do.** Decide with DR-09 whether `"*"` stays a first-party
privilege or becomes something a reviewed third party can be granted.

## 10. `deriveTokenHash` keys on the auth secret — breaking

**What happens.** `ctx.internals.deriveTokenHash` returns an HMAC of a token
under the current `BETTER_AUTH_SECRET`. It existed so `auth/scim` could store
SCIM bearer tokens hashed; SCIM tokens became API keys (ADR 0045), and no
first-party extension calls it any more (checked 2026-11-18). A hash it
returned matches only while the secret that made it is current: rotating the
secret (DR-17) leaves every stored hash unmatched, and unlike API keys
(#1777) the engine cannot rewrite them, because they live in the extension's
own tables.

**What v1 does.** Nothing. Removing the member or changing its output breaks
v1; rotation destroys these hashes, as `docs/platform/security.md` says.

**What v2 should do.** Remove `deriveTokenHash`. An extension that stores a
token issues it as an API key, or hashes it under a secret it declares itself.

## 11. Identity-provider identifiers reach the audit trail in clear — narrowing

**What happens.** The `auth/ldap` and `auth/saml` sign-in path hands the
engine the identity provider's `subject` (an LDAP DN, a SAML NameID), and
`signInRefused` carries the `identifier` the person typed. Both are written
into `zv_audit_log` as given, and either may be an email or a name. ADR 0060
keeps ids only in the trail (amendment 2026-11-21).

**What v1 does.** Nothing. The fields are part of the frozen contract.

**What v2 should do.** The engine stores a keyed hash of `subject` and
`identifier` (enough to correlate attempts, not to read the value), and the
contract says so.

## 12. `ctx.internals.audit` accepts any metadata — narrowing

**What happens.** An extension may put any JSON into an audit row's metadata
through `ctx.internals.audit`, personal data included. ADR 0060 keeps ids only
in the trail (amendment 2026-11-21).

**What v1 does.** Logs a warning when the metadata holds a value that is not
an id, a number, a boolean or an enum-like token (to be added in v1, additive).

**What v2 should do.** Refuse such metadata with a problem the extension sees.


## 13. Unbound field ciphertext from the extension surfaces — narrowing

**What happens.** Field values are sealed to their row since ADR 0059
(amendment 2026-11-21): `enc:v2:` carries a key id, and AES-GCM associated data
names the tenant, collection, field and record, so a copy elsewhere does not
decrypt. Three extension-facing writers name no row and are documented as
producing `enc:v1:`, which binds nothing: `ctx.internals.encryptSecret` (field
keyring), `ctx.internals.maybeEncrypt`, and an inline extension's `ctx.db`
update whose `WHERE` is not a single `id =` (one value for many rows). Both
`encryptSecret` and `maybeEncrypt` also return a value that already carries an
envelope untouched, so ciphertext copied from anywhere passes through them.

**What v1 does.** Keeps all three on `enc:v1:` under the current key of
`FIELD_ENCRYPTION_KEYS`, and keeps the pass-through. `decryptSecret` and
`maybeDecrypt` read `enc:v1:` and refuse `enc:v2:` (they name no row). No
first-party extension calls any of them (checked 2026-11-21); `rotate-keys`
rewrites what they wrote into an `encrypted` or `secret` column as `enc:v2:`,
and leaves a value they wrote anywhere else (ADR 0059 step 3).

**What v2 should do.** Remove `maybeEncrypt` / `maybeDecrypt` (the data API
seals and opens field values); make `encryptSecret` / `decryptSecret` take the
row they bind to, or remove them; refuse ciphertext as input; and refuse a
`ctx.db` update that sets an encrypted field without naming one row.
