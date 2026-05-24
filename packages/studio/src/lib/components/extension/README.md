# Extension UI kit (Studio)

Reusable layout for pages under `zveltio-extensions/*/studio/pages/`, synced
into `src/routes/(admin)/` at build time.

## Rules

1. **All user-visible strings** go through Paraglide: `import { m } from '$lib/i18n.svelte.js'`.
2. Add keys in `studio/messages/{en,ro,fr,de}.json` (this extension), then `bun run i18n:compile` in Studio.
3. Use `ExtensionPageShell` + `ExtensionDataPanel` instead of ad-hoc headers/tables.
4. **Never use `window.confirm()`** — use `createExtensionConfirm()` + `ConfirmModal`
   (see `src/lib/utils/extension-confirm.svelte.ts`).
5. Set `studio.navGroup` in `manifest.json` (see `nav-model.ts` groups).
6. Message keys for an extension: `{name-with-dots}.title` / `.subtitle` / `.empty`
   (e.g. `finance.expenses.title` for `finance/expenses`).

After adding keys: `bun run i18n:compile` and `bun run sync-ext`.

**Batch baseline** (import `m`, toasts, titles from manifest): `bun run i18n:ext-batch`

## Example

```svelte
<script lang="ts">
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
  import { m } from '$lib/i18n.svelte.js';
  import { Plus } from '@lucide/svelte';
</script>

<ExtensionPageShell
  title={m['crm.title']()}
  subtitle={m['crm.subtitle']()}
  search={search}
  onSearchChange={(v) => (search = v)}
  searchPlaceholder={m['common.search']()}
>
  {#snippet actions()}
    <button type="button" class="btn btn-primary btn-sm gap-1" onclick={openCreate}>
      <Plus size={14} /> {m['common.new']()}
    </button>
  {/snippet}
  {#snippet children()}
    <ExtensionDataPanel loading={loading} empty={rows.length === 0} emptyTitle={m['common.noResults']()}>
      {#snippet table()}
        <table class="table table-sm">…</table>
      {/snippet}
    </ExtensionDataPanel>
  {/snippet}
</ExtensionPageShell>
```

## Manifest: sidebar grouping

```json
"studio": {
  "navGroup": "business",
  "pages": [{ "path": "/admin/crm", "label": "CRM", "icon": "Users" }]
}
```

`navGroup` values: `business`, `finance`, `hr`, `operations`, `compliance`,
`content`, `communications`, `developer`, `projects`, `other` (default).
