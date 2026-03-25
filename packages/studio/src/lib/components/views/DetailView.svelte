<script lang="ts">
  import { Edit, X } from '@lucide/svelte';
  import DataCell from './DataCell.svelte';

  interface Props {
    record?: Record<string, any> | null;
    fields?: any[];
    config?: Record<string, any>;
    loading?: boolean;
    onEdit?: () => void;
    onClose?: () => void;
  }

  let { record = null, fields = [], config = {}, loading = false, onEdit, onClose }: Props = $props();

  // Visible fields: from config or all non-system fields
  const visibleFields = $derived(
    config.fields
      ? fields.filter((f: any) => config.fields.includes(f.name))
      : fields.filter((f: any) => !f.is_system)
  );

  // Split into full-width and half-width based on config
  function getFieldWidth(name: string): 'full' | 'half' {
    const cfg = config.fields_config?.[name];
    return cfg?.width ?? 'full';
  }
</script>

<div class="flex flex-col h-full">
  <!-- Header -->
  <div class="flex items-center justify-between p-4 border-b border-base-300 shrink-0">
    <h3 class="font-semibold text-base-content">
      {record?.name ?? record?.title ?? record?.id ?? 'Record'}
    </h3>
    <div class="flex gap-2">
      {#if onEdit}
        <button class="btn btn-sm btn-outline gap-1" onclick={onEdit}>
          <Edit size={14}/> Edit
        </button>
      {/if}
      {#if onClose}
        <button class="btn btn-sm btn-ghost btn-circle" onclick={onClose}>
          <X size={16}/>
        </button>
      {/if}
    </div>
  </div>

  <!-- Body -->
  <div class="flex-1 overflow-y-auto p-4">
    {#if loading}
      <div class="flex flex-col gap-3">
        {#each Array(6) as _}
          <div class="flex flex-col gap-1">
            <div class="skeleton h-3 w-20 rounded"/>
            <div class="skeleton h-5 w-48 rounded"/>
          </div>
        {/each}
      </div>
    {:else if !record}
      <p class="text-base-content/40 text-sm">No record selected</p>
    {:else}
      <div class="grid grid-cols-2 gap-x-6 gap-y-4">
        {#each visibleFields as field}
          <div class={getFieldWidth(field.name) === 'full' ? 'col-span-2' : 'col-span-1'}>
            <p class="text-xs font-medium text-base-content/50 uppercase tracking-wide mb-1">
              {field.display_name ?? field.name}
            </p>
            <div class="text-sm text-base-content">
              <DataCell value={record[field.name]} type={field.type}/>
            </div>
          </div>
        {/each}
      </div>

      <!-- System fields (created_at, updated_at) in footer -->
      {#if record.created_at || record.updated_at}
        <div class="mt-6 pt-4 border-t border-base-300 flex gap-6 text-xs text-base-content/40">
          {#if record.created_at}
            <span>Created: <DataCell value={record.created_at} type="datetime"/></span>
          {/if}
          {#if record.updated_at}
            <span>Updated: <DataCell value={record.updated_at} type="datetime"/></span>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</div>