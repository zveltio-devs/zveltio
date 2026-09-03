# Component Library

The shared building blocks in `packages/studio/src/lib/components/common/`, and
the rule for picking between them.

> Interaction conventions — when to use a modal, where a save button goes, how
> errors are surfaced — are in [patterns.md](patterns.md).

---

## Inventory

| Group | Components |
|---|---|
| **Shell** | `PageHeader`, `SectionCard`, `Card`, `Breadcrumb`, `CollectionTabs` |
| **Lists** | `CrudListPage`, `Pagination`, `SearchBar`, `SearchableSelect`, `EmptyState`, `EmptyIllustration` |
| **Forms** | `SchemaForm`, `Input`, `Button`, `InlineEdit`, `AddressInput` |
| **Feedback** | `Alert`, `ToastContainer`, `StatusBadge`, `Loading`, `LoadingSkeleton`, `PageSpinner` |
| **Overlays** | `Modal`, `ConfirmModal`, `CommandPalette`, `KeyboardMap` |
| **Access** | `PermissionGuard`, `PasskeysSection` |
| **Data** | `Sparkline`, `ExportActions` |
| **System** | `DemoBanner`, `UpdateBanner`, `LocaleSwitcher`, `Slot` |

Components with `.test.ts` siblings (`Alert`, `Breadcrumb`, `ConfirmModal`,
`EmptyState`, `Modal`, `Pagination`, `StatusBadge`) are the ones with pinned
behaviour — extend those tests rather than starting a new file.

---

## Forms — two patterns, deliberately

### `SchemaForm.svelte` — dynamic schemas

Use when the field set is data-driven: extensions registering fields through
`registerFormAlter`, collection-editor pages introspecting a collection schema.
Driven by a `FormSchema` value, it runs every registered `form-alter` hook
before render and owns a validator chain per field.

```svelte
<SchemaForm
  formId="core:user-invite"
  schema={inviteSchema}
  bind:values={form}
  ctx={{ user: auth.user, mode: 'create' }}
/>
```

### Hand-rolled forms — small and page-specific

Login, dashboard search, single-field modals. Threading a `FormSchema` through a
one-to-three-field form costs more than writing the markup.

**There is deliberately no third helper for the middle ground.** A middle layer
would be used twice and then diverge.

### Why not superforms

`sveltekit-superforms` solves a different problem: SvelteKit's
progressive-enhancement form actions with shared client/server Zod validation.
The admin surface is an SPA over the engine's REST API — there are no form
actions to enhance, and client/server type sharing already goes through
`@zveltio/sdk/rpc`.

| Concern | SchemaForm | superforms |
|---|---|---|
| Driven by a dynamic `FormSchema` | yes | no — statically typed at compile time |
| Works with `registerFormAlter` | yes | no |
| Wraps SvelteKit form actions | no | yes |
| Bundled Zod-derived client validation | partial | yes |
| Bundle size | ~3 KB | ~12 KB |

Revisit only if a SvelteKit-form-actions-based admin surface ships. It is not on
the roadmap.

---

## Lists — `CrudListPage.svelte`

The standard shell for the **list + primary action + create modal** pattern.
Wraps `PageHeader`, an optional `SearchBar`, the loading spinner, `EmptyState`
and `Pagination` into one component so empty states stay visually consistent.

```svelte
<CrudListPage
  title="Webhooks"
  subtitle="HTTP callbacks triggered by data events"
  count={total}
  {loading}
  actionLabel="New Webhook"
  onAction={openCreate}
  empty={{
    icon: Webhook,
    title: 'No webhooks yet',
    description: 'Send HTTP callbacks to external services when events occur.',
    actionLabel: 'Add Webhook',
    onAction: openCreate,
  }}
>
  {#snippet list()}<!-- the table or grid -->{/snippet}
  {#snippet pagination()}<Pagination ... />{/snippet}
</CrudListPage>
```

Search is opt-in via `search` + `onSearchChange`; the bar only renders once the
count passes `searchThreshold` (default 4).

Ten pages use it — Collections, Webhooks, Users, API Keys, Flows, Schema
Branches, Tenants, Zones, Views, Backup. Pages needing tabs, side panels or
drill-down detail keep their own layout. `CrudListPage` is for the 80% case, not
a mandate.

---

## Charts — `Sparkline.svelte`

Layerchart-backed inline trend for stat cards.

```svelte
<Sparkline data={revenue7d} color="var(--p)" width={120} height={32} />
```

Empty or single-value input renders nothing. For anything with axes or tooltips,
use Layerchart's `Chart` / `Svg` primitives directly rather than growing this
component.

---

## Adding a component

The bar is **three similar uses**. Two call sites are a coincidence; one is a
page. Before adding anything here, check that an existing component cannot take
a prop instead — the library is small on purpose, and a component nobody can
find gets rebuilt.
