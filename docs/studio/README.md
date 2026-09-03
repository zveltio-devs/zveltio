# Chapter 3 — Studio

The administration application: a SvelteKit 5 single-page app, built statically
and embedded into the engine binary, served at `/admin`.

`packages/studio` · Svelte 5 runes · Tailwind 4 + daisyUI 5 · Paraglide i18n

> Visual language, components and interaction patterns are the **[UI
> chapter](../ui/README.md)**. This chapter is about how the application is
> wired.

| Document | Covers |
|---|---|
| This page | Architecture, routing, data access, auth, build and embedding |
| [extension-pages.md](extension-pages.md) | How an extension contributes admin pages, fields, slots |
| [i18n.md](i18n.md) | Message catalogues, locales, and who owns which keys |

---

## 1. What it is, and what it is not

**It is a client-side SPA.** `src/routes/+layout.ts` sets `ssr = false` and
`prerender = false`, and the build uses `adapter-static`. There is no Studio
server.

The consequence is a security rule, not a preference: **anything that looks like
a server-side guard in Studio code does not run.** Client-side checks are
UX — they hide buttons a user cannot use. The engine is the only boundary. A
route that is safe because the Studio does not link to it is not safe.

---

## 2. Routing

SvelteKit route groups under `src/routes/`, each with its own layout and guard:

| Group | Serves | Notes |
|---|---|---|
| `(admin)` | The administration surface | ~35 top-level sections |
| `(client)` | `portal-client/` — authenticated customer portal | |
| `(intranet)` | `intranet/` — employee-facing pages: profile, tasks, notifications | |
| `login` | Authentication | Outside the groups |

> The directories are `(admin)`, `(client)`, `(intranet)` — parenthesised route
> groups. Older notes referring to `src/routes/admin/` are stale; that path does
> not exist.

Sections under `(admin)`: account, ai, api-keys, audit, backup, collections
(+ `erd`, `[name]`), column-permissions, developer (+ edge-functions, graphql),
extensions, flows, geospatial, insights, mail, marketplace, notifications,
onboarding, pages, permissions, projects, request-logs, rls, rpc, saved-queries,
schema-branches, settings, sql, storage, templates, tenants, users,
virtual-collections, webhooks — plus the extension catch-all `[...extPath]`.

The sidebar is generated from `src/lib/nav-model.ts`, which is the single source
of truth for grouped navigation. Core items carry a Paraglide `labelKey`;
extension items carry a label from the extension manifest. Group ordering is
`EXT_NAV_GROUP_ORDER`.

---

## 3. Talking to the engine

**All engine calls go through `src/lib/api.ts`.** Do not call `fetch` directly
from a component — the helper carries three things a bare fetch would drop:

1. **Credentials and base URL** from `src/lib/config.ts` (`ENGINE_URL`).
2. **The tenant header.** `x-tenant-slug` is sent from a value in
   `localStorage` under `zveltio.tenantSlug`. It is per-browser rather than per
   account on purpose: the same administrator may want one tab on a county
   office and another on a district. Absent, the engine falls back to its own
   resolution — the behaviour every install had before unit switching existed.
3. **Denial enrichment.** A 403 comes back with the rule that denied it, and
   `src/lib/denial.ts` turns that into a message a person can act on.

State is Svelte 5 runes in `src/lib/*.svelte.ts` — `auth.svelte.ts`,
`extensions.svelte.ts`, `extension-api.svelte.ts`, `i18n.svelte.ts`. No legacy
stores in new code.

---

## 4. Build and embedding

```sh
bun run studio:build     # vite build → packages/studio/dist
bun run studio:embed     # copy dist into the engine (two destinations)
```

`studio:embed` copies the build to **both** `packages/engine/studio-dist` and
`packages/engine/src/studio-dist`. `check:studio-embed` gates freshness, and
an E2E test asserts that the embedded build's version matches the engine's.

**`studio-dist/` is resolved relative to the current working directory.** If
`/admin` shows "Setup Required", the build is missing or you are running the
engine from a different directory — rebuild and re-embed from the repository
root.

### Split development

Studio on Vite (`:5173`) against an engine elsewhere needs both sides told about
each other:

```sh
# engine .env
CORS_ORIGINS=http://localhost:5173
# studio
VITE_ENGINE_URL=http://localhost:<engine-port>
```

Running the embedded build instead (`/admin` on the engine's own port) is
same-origin and needs no CORS at all — it is the simpler loop when you are not
editing Studio code.

**Studio build scripts must be release-safe.** This has caused three separate
incidents: a `bun run build` in the Studio directory has regressed core pages by
picking up a stale sibling build. Build from the repository root.

---

## 5. Extension surface

Extensions contribute to the Studio in four ways — pages, custom field types,
form alters, and slots. Pages are preferentially **declarative**: an extension
ships a JSON schema and the host renders it with trusted components, so no
extension code and no third-party JavaScript enters the admin bundle. See
[extension-pages.md](extension-pages.md) and the
[SDUI reference](../ui/sdui.md).

`src/lib/load-extension-contributions.ts` loads what an enabled extension
registers; `registerContributionSlot` is a Studio API (not an SDK one).

---

## 6. Other surfaces in this package

`packages/client` is a separate SvelteKit application for end users — public
site (`(public)`), employee area (`(employee)`), and partner portal
(`(partner)`), with its own auth client and `blocks/` renderer. It shares the
design system and sanitisation helpers with the Studio but is deployed
separately.
