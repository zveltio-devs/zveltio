# Studio common components

## Form components

The Studio codebase intentionally ships **two** form patterns. Pick by use case:

### `SchemaForm.svelte` — dynamic schemas (admin path)

Use when the field set is data-driven: extensions register fields via
`registerFormAlter`, collection-editor pages introspect the collection
schema, etc. Driven by a `FormSchema` value, runs every registered
`form-alter` hook before render, owns validator chains per field.

```svelte
<SchemaForm
  formId="core:user-invite"
  schema={inviteSchema}
  bind:values={form}
  ctx={{ user: auth.user, mode: 'create' }}
/>
```

### Hand-rolled forms — small, page-specific forms

For login, dashboard search, single-field modals etc. The cost of
threading a FormSchema for a 1-3 field form is higher than just writing
the markup. We don't ship a third helper for these.

### Why we don't use superforms

Superforms (`sveltekit-superforms`) targets a different problem:
SvelteKit's progressive-enhancement form actions with shared
client/server Zod validation. Our admin surface is a SPA on top of the
engine's REST API — there are no SvelteKit form actions to enhance, and
client/server type sharing already goes through `@zveltio/sdk/rpc`.

Evaluated against SchemaForm:

| Concern | SchemaForm | superforms |
|---|---|---|
| Driven by dynamic FormSchema | ✓ | ✗ (statically typed at compile time) |
| Plays nice with `registerFormAlter` | ✓ | ✗ |
| Wraps SvelteKit form actions | ✗ | ✓ |
| Bundled Zod-derived client validation | partial | ✓ |
| Bundle size | ~3 KB | ~12 KB |

Decision: stick with SchemaForm + hand-rolled forms. Revisit if we ship
a SvelteKit-form-actions-based admin surface (currently not on the
roadmap).

## List pages

### `CrudListPage.svelte` — standard list shell

For pages that follow the **list + primary action + create modal** pattern
(Collections, Webhooks, Users, API Keys, Flows, Schema Branches, Tenants,
Zones, Views, Backup — all 10 use this). Wraps PageHeader, optional
SearchBar, loading spinner, EmptyState, and Pagination into one shell so
empty states are visually consistent across the admin.

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
  {#snippet list()}<!-- the table/grid -->{/snippet}
  {#snippet pagination()}<Pagination ... />{/snippet}
</CrudListPage>
```

Use search via `search` + `onSearchChange` props; the bar only renders once
the count grows past `searchThreshold` (default 4).

Pages that need richer layouts (tabs, side panels, drill-down detail) keep
rolling their own — `CrudListPage` is for the 80% case.

## Modal sizing convention

DaisyUI's `modal-box` accepts a `max-w-*` tweak. Pick by content density:

| Class            | Use case                                    |
|------------------|---------------------------------------------|
| `max-w-md`       | Simple form (≤4 fields, basic inputs) — default for create / invite modals |
| `max-w-2xl`      | Complex form (multiple sections, helper text, conditional fields) |
| `max-w-3xl/4xl`  | Preview / split-view modals (form + live preview side-by-side) |

`max-w-sm` is too tight for actual inputs — use `max-w-md` instead.
`max-w-lg` overlaps with `max-w-md` in intent; pick one or the other.

## Error handling

Three error UI shapes — pick by *who* needs to see *what*:

| Shape                       | When                                                                  | Example                       |
|-----------------------------|-----------------------------------------------------------------------|-------------------------------|
| `toast.error(msg)`          | Transient action failures (save, delete, send). User triggered the action; they see the result. | "Failed to delete webhook"    |
| `<div class="alert alert-error">` inline inside the form/page  | Validation errors or page-level state problems (form won't submit, system status degraded). Lives next to the bad input or at the top of the section. | "Slug must be lowercase"      |
| `<EmptyState />` with error variant | A whole list failed to load (network error on initial fetch). Tells the user no data is shown and why. | "Couldn't load collections — retry" |

Avoid silent failures — every catch should either toast, set an inline
error, or surface an empty state. `console.error(...)` alone is never
enough.

## Validation timing

| When to validate                      | UX                                                              |
|---------------------------------------|-----------------------------------------------------------------|
| As the user types (live)              | Format constraints with cheap checks: slug regex, email shape, number range. Helper text in `text-error` next to the field. |
| On submit                             | Required fields, async server-side checks (uniqueness), cross-field rules. Show inline alert at top of form OR per-field errors. |
| Never on focus / blur of a fresh input | Don't yell at users for empty fields they haven't started filling yet. Onblur-validation is only for non-empty values. |

The `SchemaForm` component handles this through the schema's `required`,
`pattern`, and `validate` field options. Hand-rolled forms should
follow the same timing.

## Action button placement

| Where           | Pattern                                                                 |
|-----------------|-------------------------------------------------------------------------|
| Page header     | Primary action (New X) on the right, via `PageHeader` slot or `CrudListPage` `actionLabel` |
| Modal           | `Cancel` + `Save` at bottom-right inside `<div class="modal-action">`   |
| Decision modal  | Two equal-weight buttons side-by-side (e.g. Approve/Reject)             |
| Table row       | Hidden until `group-hover` or `focus-within`; right-aligned             |
| Settings panel  | One `Save` button per panel, at the bottom-right of the panel           |

The previous pattern of inline-per-row save buttons in Settings (rate
limits) was removed — Settings now follows the "save panel" pattern.

## Tab UI conventions

Pages with multiple top-level sections use DaisyUI tabs. Two patterns:

| Pattern                       | When to use                                    |
|-------------------------------|------------------------------------------------|
| `.tabs.tabs-bordered` + local state | Sections only differ in content, no separate URLs (Permissions: Matrix / Roles / Hierarchy) |
| Query-param tabs (`?tab=schema`)    | Sections benefit from deep-linking + browser back-button (Collections detail: Data / Schema / API / Settings) |

Avoid mixing both patterns in the same surface. New tabs default to the
local-state pattern unless a deep-link use case exists.

## CRUD pattern — modal vs dedicated page

- **Modal**: creating a NEW item with a small, focused form (1-6 fields).
  Edits inline. Lives on the list page. — Webhooks, API Keys, Users,
  Schema Branches, Backups.
- **Dedicated page (`/<resource>/[id]`)**: editing an EXISTING item that
  has its own tabs (data + schema + settings), nested resources, or rich
  editors (collections, flows with step builder, edge functions).
  Drill-down is a navigation, not a popover.

Rule of thumb: if the form needs >6 fields, has tabs, or has its own
sub-resources — make it a page. Otherwise — modal.

## Chart components

### `Sparkline.svelte` — inline trend chart (S5-10)

Powered by Layerchart. Small inline visualization for stat cards:

```svelte
<Sparkline data={revenue7d} color="var(--p)" width={120} height={32} />
```

Empty / single-value input renders nothing. For larger charts with
axes + tooltips, use Layerchart's `Chart` / `Svg` primitives directly.
