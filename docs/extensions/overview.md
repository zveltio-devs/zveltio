# Extensions

Zveltio ships a headless engine. **Extensions** are what turn it into a business
system — CRM, invoicing, HR, e-commerce, compliance, mail. They are plugins, not
forks: an operator installs them, they add tables, routes and admin pages, and
they can be disabled again.

There are **56 official extensions**. See the [catalog](/extension-catalog) for
the full list.

---

## How an extension reaches your instance

Extensions are installed from the registry, not from a git checkout:

```
zveltio-extensions repo  →  CI publishes  →  registry.zveltio.com  →  your engine
```

From the Studio, go to **Marketplace**, pick an extension, and install. From the
command line:

```sh
zveltio extensions list
zveltio extensions install <name>
zveltio extensions enable <name>
zveltio extensions disable <name>
```

Installs verify an **Ed25519 signature** by default. `REQUIRE_EXTENSION_SIGNATURES=false`
exists only for unsigned private mirrors, and additional trusted signers go in
`REGISTRY_PUBLIC_KEYS_JSON`.

Installing an extension shows you what it is asking for — its declared
permissions — and records your consent. An extension cannot quietly acquire a
capability it did not declare.

---

## What an extension can add

| Contribution | Where it appears |
|---|---|
| **HTTP routes** | Mounted at `/ext/<name>/` |
| **Database tables** | Its own migrations, in the `zvd_*` namespace |
| **Studio pages** | New sections in the admin sidebar |
| **Custom field types** | Available when designing a collection |
| **Form alters** | Extra fields injected into existing forms |
| **Slots** | Components at named points in the admin chrome |
| **Hooks** | Pre-write, post-write, query-alter, entity-access |
| **Cron jobs** | Scheduled work |
| **Flow steps** | New step types for automation flows |
| **Services** | Functions other extensions can call |

---

## Routes and authentication

An extension's routes live under `/ext/<name>/`, and they are **fail-closed at
the engine**: a valid session is required unless the extension's manifest
explicitly lists a sub-path as public. An extension author who forgets an
authentication check gets a 401, not an exposure.

Older documentation describes `/api/<name>` routes for extensions. That is out
of date — capabilities that used to live in core and moved out keep their old
`/api/*` path only as a **410 Gone** response carrying the new address:

| Old path | Now |
|---|---|
| `/api/approvals` | `/ext/workflow/approvals` |
| `/api/export` | `/ext/data/export` |
| `/api/import` | `/ext/data/import` |
| `/api/media` | `/ext/content/media` |
| `/api/edge-functions` | `/ext/developer/edge-functions` |

---

## Isolation

| Tier | Who runs there | What it means |
|---|---|---|
| `inline` | First-party, reviewed extensions | In-process. Trusted code. |
| `worker` | Community extensions | A separate process, a restricted SQL allowlist limited to user tables and the extension's own namespace, a reserved connection with a statement timeout, and a database role with no access to the authentication tables. |
| WASM | Available, opt-in | Strict isolation. |

Worker isolation is a strong guard-rail. It is not an adversarially-tested
sandbox — install community extensions with the same judgement you would apply
to any third-party code running on your server.

Tenant isolation is guaranteed by the **host**, not by each extension: every
extension-owned tenant table is reconciled onto the engine's own RLS predicate
at boot. See [multi-tenancy](/multi-tenancy).

---

## Configuration

An extension reads configuration from environment variables named
`ZVELTIO_EXT_<NAME>_*`, surfaced to it as `ctx.config.vars`. Secrets an
extension stores are encrypted at rest.

---

## What is *not* an extension

These are engine core, and documentation claiming otherwise is out of date:
collections, storage, webhooks, realtime, audit, notifications, automation
flows, backup, insights, saved queries, schema branches, and tenants.

`developer/views` and `content/page-builder` were merged into
[`content/pages`](/extension-catalog) and no longer exist as separate
extensions.

---

## Building your own

```sh
zveltio extension init <name>
```

Then read the [Developer Guide](/extension-developer-guide) — mental model,
manifest, engine code, migrations, hooks, Studio pages, testing and publishing —
and the [Cookbook](/extension-cookbook) for worked recipes. Submission rules are
in the [Marketplace Policy](/marketplace-policy).

Extension admin pages are preferably **declarative**: you ship a JSON page
schema and the host renders it with its own trusted components. That means no
build step for your Studio UI, and no third-party JavaScript in anyone's admin.
