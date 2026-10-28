<script lang="ts">
/** Test-only: Dropdown and Tabs take snippets and callbacks a props object cannot build. */
import Dropdown from '@zveltio/ui/Dropdown.svelte';
import Tabs from '@zveltio/ui/Tabs.svelte';

let { onEdit, onDelete }: { onEdit: () => void; onDelete: () => void } = $props();
let tab = $state('general');
</script>

<Dropdown
  label="Actions"
  items={[
    { label: 'Edit', onSelect: onEdit },
    { label: 'Delete', onSelect: onDelete, danger: true, disabled: true },
  ]}
/>
<Tabs
  label="Settings"
  bind:value={tab}
  tabs={[
    { value: 'general', label: 'General' },
    { value: 'advanced', label: 'Advanced' },
  ]}
>
  {#snippet panel(v)}<p>panel {v}</p>{/snippet}
</Tabs>
<output data-testid="tab">{tab}</output>
