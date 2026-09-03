# Extension Pages in the Studio

How an enabled extension contributes to the admin UI, and what the host does
with each contribution.

> The authoring side — how to *write* these — is
> [../extensions/developer-guide.md](../extensions/developer-guide.md) §10.
> The page schema itself is [../ui/sdui.md](../ui/sdui.md).

---

## 1. Four contribution types

| Contribution | Declared in | Rendered by |
|---|---|---|
| **Pages** | `manifest.studio.pages[]` | The `[...extPath]` catch-all route, or `extensions/[...path]` |
| **Custom field types** | `contributes.fieldTypes` | The collection field editor |
| **Form alters** | registered at runtime | `SchemaForm`, before render |
| **Slots** | `contributes.slots` | `Slot.svelte` at named mount points |

Loading is done by `src/lib/load-extension-contributions.ts`. `registerContributionSlot`
is a **Studio** API, not an SDK one — three call sites use it.

---

## 2. Pages: declarative by default

A manifest page entry points either at an SDUI schema or at nothing (meaning a
bespoke page):

```json
"studio": {
  "pages": [
    { "path": "/admin/ai",      "label": "AI",      "icon": "Bot",
      "schema": "schemas/ai.json" },
    { "path": "/admin/ai/chat", "label": "AI Chat", "icon": "MessageSquare" }
  ],
  "navGroup": "developer"
}
```

**With a `schema`**, the host renders the page itself using trusted generic
components — `SchemaPage.svelte`, `SettingsPage.svelte`, `DetailLayout.svelte`,
`BuilderLayout.svelte`. No extension code runs in the admin bundle, there is no
per-extension build step, and no third-party JavaScript enters the Studio.

**Without a `schema`**, the extension ships Svelte and the host copies it into
the route tree on enable. Reserve this for genuinely unusual surfaces.

`icon` is a Lucide icon name. `navGroup` places the item in the sidebar; group
ordering is `EXT_NAV_GROUP_ORDER` in `src/lib/nav-model.ts`.

---

## 3. The page belongs to the extension

`scripts/check-extension-page-ownership.ts` fails the build if the host carries
page code for a specific extension. The host provides the renderer and the
generic components; it does not know what "an invoice" is.

The same discipline applies to translations: every message key a page renders
must be owned by that extension, by a declared dependency, or by the host's
shared catalogue. See [i18n.md](i18n.md).

---

## 4. Enable, disable, and what does not happen

Enabling an extension registers its contributions and copies any Svelte pages
into the route tree. **`disable` followed by `enable` does not reload the
bundle** — the runtime keeps what it loaded. During development, restart the
engine rather than trusting the toggle.

More generally: the runtime loads `engine/index.js`, the built bundle. Editing
extension source and re-enabling changes nothing until you repack.

---

## 5. Data access from an extension page

Extension pages call the engine through the same `src/lib/api.ts` helper as core
pages, so they inherit the tenant header, credentials and denial enrichment.
`src/lib/extension-api.svelte.ts` wraps the extension-scoped surface.

Routes live under `/ext/<name>/` and are **fail-closed** at the engine: a
session is required unless the manifest lists the sub-path in `publicRoutes`.
A page that appears to work while logged out is a finding.

---

## 6. Slots

Slots let an extension put a component at a named point in the host chrome —
`topbar.center`, `dashboard.hero` and similar. Declared in
`contributes.slots`, rendered by `Slot.svelte`.

Slots are the escape hatch for "this belongs on a screen the extension does not
own". They are not a general composition mechanism: a new slot name is a change
to the host's contract with every extension, so add one deliberately.
