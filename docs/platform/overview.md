# What Zveltio Is

Zveltio is a **self-hosted Business OS**: a headless backend that becomes a
complete business system through extensions. One binary, one Postgres database,
installed on hardware the organisation controls.

**Version:** see [`packages/engine/package.json`](../../packages/engine/package.json). MIT licensed. Runtime is Bun.

---

## The two-sentence version

The **engine** is a genuine headless BaaS — dynamic collections, auth, RBAC,
row-level multi-tenancy, REST/RPC, realtime, storage, audit trail, automation,
webhooks, edge functions. On top of that, **extensions** turn it into a
self-hosted SaaS — CRM, invoicing, HR, e-commerce, compliance — assembled from
modules an operator installs, rather than code a developer forks.

---

## The shape of the product

This matters more than it sounds, because it determines which threats are worth
modelling and which are not.

- **There is no anonymous data API.** Every data route under `/api/*` requires
  a session or an API key. Public surfaces — a published site, a form
  submission, a storefront, an SSO callback — exist only where an installed
  extension declares them in its manifest.
- **The tenant is an organisation, not an end user.** Users do not sign
  themselves up into isolated sandboxes; an operator provisions organisational
  units.
- **The operator is an administrator with shell access.** Threat modelling
  starts from that: an attack requiring operator privileges is usually not a
  finding, because that person already owns the machine.

## Who runs it

Companies and public institutions, on their own hardware. The target market is
**self-hosted first** — cloud is deliberately deprioritised. Deployments are
frequently hierarchical: a parent organisation with subordinate units, where a
consolidating parent reads its subtree but writes only its own node. The tenancy
model is built for that shape, not for a flat pool of unrelated customers.
See [multi-tenancy.md](multi-tenancy.md).

---

## What it ships

| Capability | What it means |
|---|---|
| **Zero-downtime DDL** | Alter multi-million-row tables while users are active — writes block only for milliseconds at the final swap, no maintenance window. See [Ghost DDL](../engine/ghost-ddl.md). |
| **Schema branching** | Record schema changes on a branch, diff, review and preview them, then merge. |
| **Bring Your Own Data** | Import tables from an existing database into Zveltio's PostgreSQL; they become collections with admin UI, REST API and permissions. `integrations/migrators` imports from HubSpot, Notion and Airtable. |
| **Per-field encryption** | Mark any field `encrypted: true`; AES-256-GCM, transparent at the engine level. |
| **Live TypeScript types** | `zveltio generate-types` once, and every SDK call is typed from that point on. |
| **Immutable audit trail** | Every write logged with user, IP, and before/after values. GDPR export and erasure built in. |
| **Server-driven UI** | Extension admin pages ship as JSON schemas rendered by trusted host components — no per-extension build, no third-party JavaScript in the admin. See [SDUI](../ui/sdui.md). |
| **55 official extensions** | Including Romanian compliance (e-Factura, e-Transport, SAF-T) and a D300 VAT return in accounting. See the [catalog](../extensions/catalog.md). |

---

## Strengths and trade-offs

Where it is strong: self-hosted and MIT-licensed with no per-seat fees; tenant
isolation enforced by PostgreSQL row-level security rather than application
filters; the headless engine and the business extensions on one database, one
permission model and one audit trail; schema changes on live tables; signed
extensions with worker isolation and declarative admin pages.

Where it is not there yet: beta, with no SOC 2 or ISO 27001 certification, and
a small ecosystem of first-party extensions.

---

## Product boundaries — what Zveltio deliberately is not

Stated because these come up repeatedly as feature requests:

- **Not a multi-tenant SaaS host.** It isolates organisational units inside one
  installation. It is not designed to host thousands of unrelated paying
  customers on shared infrastructure.
- **Not a general-purpose PaaS.** Edge functions exist to extend the data layer,
  not to run arbitrary workloads.
- **Not framework-agnostic in the admin.** The engine and SDK are fully
  framework-agnostic — everything is REST and WebSocket. The *rendering* of
  admin pages is Svelte. SDUI is the answer to that: extension pages are
  declarative JSON, so an extension author never writes Svelte, and the host
  could re-implement the renderer in another framework without touching a
  single extension.

---

## Repository layout

Two public repositories, conventionally cloned as siblings:

```
zveltio/                  the engine, Studio, client, SDK, CLI  (this repo)
zveltio-extensions/       the 55 official extensions
```

CI clones `zveltio-extensions` as `../zveltio-extensions`, using a paired branch
when one exists with the same name as the PR's branch. Several quality gates in
this repository scan the sibling; the path is hardcoded.

Supporting repositories: `zveltio-website` (the public site, which syncs its
documentation from this one), `zveltio-registry` (the extension registry at
`registry.zveltio.com`).

---

## Release status

The **extension platform and marketplace are API-stable in beta** — the SDK
extension surface (`ZveltioExtension`, `@zveltio/sdk/extension`, manifest v2,
the marketplace flow, the worker isolation contract) must not be broken. Engine
internals and Studio layout may still move.

The `1.0.0-alpha.*` track is closed (last release `alpha.129`); new installations
use beta.

Versioning policy is in [versioning.md](versioning.md). Cutting a release is a
manual, owner-only decision — never an autonomous bump or tag.
