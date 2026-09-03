# Chapter 5 — Extensions

Extensions are how Zveltio becomes a business system. They are **plugins, not
forks**: an operator installs them, they add tables, routes, admin pages, hooks
and scheduled jobs, and they can be disabled again.

| Document | Covers |
|---|---|
| [developer-guide.md](developer-guide.md) | **The reference.** Mental model, manifest, engine code, migrations, hooks, services, cron, Studio pages, testing, publishing, isolation tiers |
| [cookbook.md](cookbook.md) | Worked recipes for common tasks |
| [authoring.md](authoring.md) | Authoring conventions and review expectations |
| [signatures.md](signatures.md) | Ed25519 signing and verification |
| [marketplace-policy.md](marketplace-policy.md) | What is accepted into the registry, and the tier rules |
| [catalog.md](catalog.md) | The 56 official extensions |
| [overview.md](overview.md) | User-facing introduction to the plugin system |
| [../ui/sdui.md](../ui/sdui.md) | The declarative page schema |

Start with the [developer guide](developer-guide.md); §12 is the local
development loop.

---

## 1. Where extensions live

First-party extensions are **not in this repository**. They live in the sibling
repository `zveltio-extensions`, conventionally cloned as `../zveltio-extensions`.

`packages/engine/extensions/` is a **gitignored runtime install cache**. It is
not source, and editing it is not editing an extension. Resolution order at
runtime:

1. `EXTENSIONS_DIR` (absolute path — the recommended setting for development)
2. `./extensions/` relative to the working directory
3. the sibling repository

To reset: stop the engine and delete `packages/engine/extensions/*`.

**The runtime loads the built bundle `engine/index.js`, not `engine/routes.ts`.**
Editing the TypeScript source and restarting changes nothing until you repack.
This has cost real debugging time in both directions — a fix that "did not
work", and a finding reported against source that never executes.

---

## 2. Anatomy

```
<category>/<name>/
├── manifest.json        identity, permissions, contributions, integrity
├── engine/
│   ├── index.ts         entry point — the ZveltioExtension object
│   ├── routes.ts        Hono routes, mounted at /ext/<name>/
│   ├── migrations/      NNN_name.sql, with -- UP and -- DOWN sections
│   └── index.js         the BUILT BUNDLE — this is what runs
├── studio/              Svelte pages (Tier 3) — or:
└── schemas/*.json       SDUI page schemas (preferred)
```

### The manifest

Every manifest carries `name`, `displayName`, `category`, `description`,
`version`, `zveltioMinVersion`, `zveltioMaxVersion`, `package`, `permissions`,
`contributes`, and `studio`. 55 of 56 also carry `engine` and `integrity`.
Optional: `resources`, `publicRoutes`, `dependencies`, `peerDependencies`,
`sensitiveResources`, `globalRoutes`, `requires`.

JSON Schema: [`../manifest-v2.schema.json`](../manifest-v2.schema.json).
Field-by-field reference: [developer-guide.md §4](developer-guide.md).

**`manifest.resources` is not `manifest.permissions`.** `permissions` are
capabilities the host grants (database, ddl, network, secrets, …);
`resources` are the things the extension exposes for authorization. They are
checked by different machinery.

---

## 3. The three contract surfaces

1. **Engine** — Hono routes at `/ext/<name>/`, migrations, pre/post-write hooks,
   query-alter, entity-access, services, cron.
2. **Studio** — pages, custom field types, form alters, slots.
3. **The manifest** — what the extension declares it needs and provides.

The SDK extension surface (`ZveltioExtension`, `@zveltio/sdk/extension`,
manifest v2, the marketplace flow, the worker isolation contract) is
**API-stable in beta. Do not break it.** Engine internals and Studio layout may
move.

---

## 4. Authentication is fail-closed at the host

`middleware/extension-auth-gate.ts` requires a valid session for anything under
`/ext/<name>/*` unless the manifest lists that sub-path in `publicRoutes`. An
extension author who forgets an inline check gets **401, not exposure**.

This inverts the historical design, and older comments in the tree still
describe the fail-open version. Check the opt-out list, not the comments.

Beyond authentication, an extension authorises with `permissionGate(ctx, '<resource>')`
and the Casbin role mapping. See
[../platform/security-model.md](../platform/security-model.md).

---

## 5. Isolation tiers

| Tier | Mode | What it means |
|---|---|---|
| 1 | `inline` (default) | In-process. Trusted code. First-party extensions run here. |
| 2 | `worker` | Separate process, restricted SQL allowlist (user tables plus its own `zv_<ext>_*` namespace), a reserved connection with a statement timeout, and the `zveltio_worker` database role which holds **no grants on the Better-Auth tables**. |
| 3 | WASM | Strict isolation, available and deliberately not the default. |

**Community extensions run worker-isolated.** Worker isolation is a guard-rail,
not an adversarially-tested sandbox — treat untrusted code accordingly.

The CLI decides the tier from the manifest and your granted publisher trust
level; `zveltio extension pack` without `--first-party` leaves
`isolation: "worker"`.

---

## 6. Configuration and secrets

An extension reads configuration through **`ctx.config.vars`**, populated from
environment variables named `ZVELTIO_EXT_<NAME>_*`. Not `process.env`, and not
new fields on `ExtensionConfig`. The `ai` extension additionally keeps a keyring
with an `aes256gcm-ai:` envelope.

---

## 7. Tenant isolation inside an extension

Extension tables are tenant-scoped by the **host**, not by the extension.
Extensions install their own isolation from a copied `002_tenant_rls.sql`, and
every one of those copies was fail-open — no tenant context meant *every*
tenant's rows, where the engine's own tables meant none. A boot reconciler now
rewrites every extension-owned tenant table onto the host predicate, so tenant
isolation is something the host guarantees rather than something 56 authors each
get right.

Never reach the database outside the request-scoped handle. Read
[../platform/multi-tenancy.md](../platform/multi-tenancy.md) §7 before writing
data access.

---

## 8. Studio pages: declarative first

Prefer an **SDUI JSON schema** over a Svelte page. The host renders it with
trusted generic components, which means no per-extension build, no toolchain,
and no third-party JavaScript in the admin bundle. The vocabulary was derived
from the real extension pages and reduces to two archetypes — list+form and
settings. See [../ui/sdui.md](../ui/sdui.md).

Bespoke Svelte pages remain possible (Tier 3) for genuinely unusual surfaces.

An extension **owns its Studio page** — `scripts/check-extension-page-ownership.ts`
enforces that the host does not carry per-extension page code.

---

## 9. Publishing

```sh
zveltio extension init <name>       # scaffold
zveltio extension validate          # manifest + contract checks
zveltio extension pack              # build + archive + sign
zveltio extension publish           # upload to the registry
```

Signing uses Ed25519; installs verify signatures by default.
`REQUIRE_EXTENSION_SIGNATURES=false` exists only for unsigned private mirrors,
and extra signers go in `REGISTRY_PUBLIC_KEYS_JSON`.

**The same bytes at the same version are refused.** A fix does not reach
installations without a version bump — and a bumped version does not reach them
without a repack, because the runtime loads the bundle.

Engine installs come from the registry, not from a git checkout: repository →
`sync.yml` → `registry.zveltio.com`. See
[marketplace-policy.md](marketplace-policy.md) and
[signatures.md](signatures.md).
