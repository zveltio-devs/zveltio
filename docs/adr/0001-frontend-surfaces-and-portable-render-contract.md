# ADR 0001 — Frontend surfaces and the portable render contract

- **Status:** Accepted
- **Date:** 2026-07-16
- **Deciders:** project owner + engineering
- **Context tag:** beta.30 → 3.0.0 (implemented before the stable cut)

## Context

On a fresh install, visiting the server root (`ip/`) redirects to `/admin/` and an
anonymous visitor lands on the admin login screen. There is no public-facing
surface — every SaaS-class product has public pages (marketing, docs, public
forms, a customer/partner area), so Zveltio needs one too.

The naïve fix is to add public routes inside the Studio (admin) app. That is
possible — the studio already carries `(client)` and `(intranet)` route groups —
but it is the wrong call:

- **Security surface.** The admin bundle would be served to anonymous visitors.
  Route guards hide *views*, not the *JavaScript*; the admin code ships to the
  browser regardless.
- **No framework choice.** Zveltio targets the **business** market, where
  integrators and agencies routinely bring their own stack (Next.js, Nuxt,
  Astro). A monolithic Svelte admin locks them out.
- **Bundle weight.** A public marketing page would drag the entire admin app.

The owner's instinct — keep admin separate, make the frontend modular — is
correct. This ADR records how.

## What already exists (important — this is not greenfield)

The backend is already a **headless, permission-aware content system**:

- **Content is data.** Zones → Pages → Views. The render API respects
  `zvd_zones.access_roles` and `zvd_pages.auth_required`, and the public render
  endpoints work **without auth** (`packages/engine/src/routes/zones.ts`):
  - `GET /api/zones/:slug/render` → navigation + zone theme
  - `GET /api/zones/:slug/render/:pageSlug` → page + resolved views + data
- **Blocks are a registry.** The `content/page-builder` extension contributes
  `clientComponents` (Hero, CTA, Text, Grid…) — a component registry, not
  hard-coded markup.
- **A separate web host is already scaffolded.** `packages/client`
  (`@zveltio/client`) is a distinct SvelteKit app with `(public)`, `(employee)`
  and `(partner)` route groups, its own auth, and SSR. It builds to `client-dist`,
  which the engine already serves at the `/*` catch-all
  (`packages/engine/src/index.ts`, `CLIENT_DIST`).

What was missing/broken: the host never actually rendered — its public page read a
`sections` shape that the API never returned (`views`), the root `/` showed a
sign-in fallback instead of a public page, no **public** zone was seeded (only the
authenticated `client`/`intranet` portals), and the host wasn't shipped by default.

## Decision

**Three frontend surfaces, one backend, unified by a published render contract.**

### 1. Three surfaces, separately built

| Surface | Audience | App | Path |
|---|---|---|---|
| **Admin** | administrators (config) | `packages/studio` (`@zveltio/studio`) | `/admin` |
| **App + Public** | anonymous visitors, and authenticated non-admin users (employees, partners, clients) | `packages/client` (`@zveltio/client`) | `/` |
| *(future BYO)* | integrators using another framework | their own | anywhere |

Admin stays its own bundle. It is never served to anonymous visitors. The public
and authenticated-app surfaces live in the **web host** (`packages/client`), which
contains **zero admin code**.

### 2. Permission filtering stays server-side

The web host is deliberately "dumb". It asks the API *"render zone X / page Y as
whoever I am"* and the server returns only what that caller may see (filtered by
`access_roles` / `auth_required`). Consequences:

- **Security:** the client never holds hidden content or admin logic.
- **Elegance:** *one* host serves all user types — the same page renders
  differently per caller because the server sends different views. Anonymous,
  employee, and partner are not three apps; they are three permission contexts
  against one renderer.

### 3. The render contract is published and portable

The render response is a stable, documented JSON shape (below). The web host is a
**reference implementation** of a contract, not the only possible renderer:

- Zveltio ships the SvelteKit reference host so a fresh install *just works*
  (WordPress-like, zero config).
- Because the contract is data, the **same** page/zone/view + block model can be
  rendered by a Next.js / Nuxt / Astro host. `@zveltio/sdk-react` and
  `@zveltio/sdk-vue` already exist as API SDKs; they grow a block-renderer layer
  (Phase 2) so BYO-framework needs no fork.

This is the innovative middle path, and it is on-brand with the existing SDUI
direction (extensions already describe their **admin** UI as data; this extends
the same philosophy to the **public/app** frontend):

- **WordPress** locks rendering to PHP themes.
- **Headless CMS** (Strapi/Contentful) hand you JSON and make you build *all*
  rendering yourself.
- **Zveltio:** declarative, permission-aware pages (data) **+** a portable
  block-render contract **+** a working default host. The frontend becomes as
  modular and swappable as the backend.

## Two content systems — which is canonical for public

The codebase has **two** content systems, and it matters which serves what:

- **Page-builder CMS** (`content/page-builder` extension, default-on): `zv_pages`
  with a `blocks` JSONB array. Purpose-built for **authored content pages**
  (marketing, docs, landing). This is the **canonical public** system.
- **Zones / Views** (`zvd_zones` / `zvd_pages` / `zvd_views`): a page composes
  **data views** (a collection rendered as table / gallery / stats / chart …).
  Purpose-built for **authenticated data portals** (employee, partner, client).
  `zvd_views.view_type` only permits data-view types — it is *not* a
  content-block system, and is out of scope for the public marketing surface.

The public frontend renders the **page-builder** contract. The authenticated
portals render the zones contract. Both go through the same host, differing by
route group and permission context.

## The public render contract (v1) — page-builder

Read model (canonical): `zv_pages.blocks` is a JSONB array of `{ type, content }`,
which is exactly what the Studio block editor writes
(`POST /ext/content/page-builder/blocks`). The public read endpoints (no auth,
`status = 'published'` only) return:

`GET /ext/content/page-builder/cms` → list published pages:

```jsonc
{ "pages": [ { "id": "…", "title": "Home", "slug": "home", "is_homepage": true } ] }
```

`GET /ext/content/page-builder/cms/:slug` → one published page + its blocks:

```jsonc
{
  "page": { "id": "…", "title": "Welcome", "slug": "home",
            "meta_title": "…", "meta_description": "…", "og_image": "…" },
  "blocks": [
    { "type": "hero",     "content": { "title": "…", "subtitle": "…", "cta_text": "…", "cta_url": "…" } },
    { "type": "richtext", "content": { "html": "…" } }
    // a data-backed block additionally carries a resolved `data: [ … ]`
  ]
}
```

Rules:

- A **block** is `{ type, content, data? }`. The host maps `type` → a component
  via its **block registry**. Unknown types degrade to a visible placeholder,
  never a crash.
- Only `status = 'published'` pages are visible publicly; drafts return `404`.
- The **homepage** is the page with slug `home` (served at `/`).
- Built-in block `type`s in the reference host: `hero`, `richtext`, `cta`,
  `image`, `gallery`, `columns`, `collection` (data-backed). Extensions/authors
  may add more; unknown types are placeholdered (Phase 2 unifies the registry).

Note — the zones contract (authenticated portals) is the separate
`GET /api/zones/:slug/render/:pageSlug` → `{ zone, page, views:[{ definition:{view_type,config}, data:{records} }] }`,
with `access_roles` / `auth_required` enforced server-side. Documented here only
to keep the two systems distinct.

## What ships now (Phase 1 — this change, before the stable cut)

1. **Reference host rendering fixed.** `packages/client` renders the real contract
   (`views` + `definition.view_type` + `data.records`), via an extracted block
   **registry** (`$lib/blocks/`) — the seed of the portable contract.
2. **Root `/` renders the public homepage** of the public zone (falls back
   gracefully when none is configured).
3. **A default public zone is seeded** (`www`, active, `access_roles = {}` = public)
   with a homepage (`is_homepage = true`, `auth_required = false`) and a welcome
   hero — the WordPress-like "it works" moment.
4. **The engine serves the web host at `/`** on a fresh install; `/admin` is
   untouched.

## What is deferred (Phase 2 — post-stable, tracked)

- `@zveltio/sdk-react` / `@zveltio/sdk-vue` gain block-render components so a
  Next/Nuxt host renders the same contract.
- Extension-contributed blocks (`page-builder` `clientComponents`) unified into
  the same registry the reference host uses.
- A published "build your own host" guide + a JSON Schema for the contract.

## Consequences

- **Positive:** admin code never reaches anonymous visitors; public/app is a lean
  separate bundle; one renderer serves all permission contexts; BYO-framework
  becomes a supported path, not a fork; fresh installs show a real homepage.
- **Cost:** two frontend apps to build and ship (mitigated — the shared layer is
  `@zveltio/sdk` + `@zveltio/components` + the contract, not duplicated logic).
- **Risk:** the portable contract is a commitment; changing it is a breaking
  change once third-party hosts exist. Versioned as "v1" from the start.

## Alternatives considered

- **Public routes inside Studio.** Rejected: ships admin JS to anonymous
  visitors, no framework choice, bundle weight. (The very coupling this ADR
  removes.)
- **A single new app for all three surfaces.** Rejected: admin's privilege and
  UX are different enough to warrant isolation; mixing them re-introduces the
  security-surface problem.
- **Headless-only, no default host.** Rejected for the business audience: it
  breaks the zero-config install promise. We ship a reference host *and* publish
  the contract.
