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

## Chart components

### `Sparkline.svelte` — inline trend chart (S5-10)

Powered by Layerchart. Small inline visualization for stat cards:

```svelte
<Sparkline data={revenue7d} color="var(--p)" width={120} height={32} />
```

Empty / single-value input renders nothing. For larger charts with
axes + tooltips, use Layerchart's `Chart` / `Svg` primitives directly.
