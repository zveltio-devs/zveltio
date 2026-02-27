<script lang="ts">
  import { onMount } from 'svelte';

  const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

  let templates = $state<any[]>([]);
  let loading = $state(true);
  let showCreateModal = $state(false);
  let creating = $state(false);

  let form = $state({
    name: '',
    description: '',
    collection: '',
    items: [{ label: '', required: false, order_idx: 0 }],
  });

  onMount(async () => {
    await loadTemplates();
  });

  async function loadTemplates() {
    loading = true;
    try {
      const res = await fetch(`${engineUrl}/api/checklists/templates`, { credentials: 'include' });
      const data = await res.json();
      templates = data.templates || [];
    } finally {
      loading = false;
    }
  }

  function addItem() {
    form.items = [...form.items, { label: '', required: false, order_idx: form.items.length }];
  }

  function removeItem(i: number) {
    form.items = form.items.filter((_, idx) => idx !== i);
  }

  async function createTemplate() {
    if (!form.name || form.items.some((i) => !i.label)) return;
    creating = true;
    try {
      const res = await fetch(`${engineUrl}/api/checklists/templates`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, collection: form.collection || undefined }),
      });
      if (!res.ok) throw new Error('Failed');
      showCreateModal = false;
      form = { name: '', description: '', collection: '', items: [{ label: '', required: false, order_idx: 0 }] };
      await loadTemplates();
    } finally {
      creating = false;
    }
  }

  async function deleteTemplate(id: string) {
    if (!confirm('Delete this template?')) return;
    await fetch(`${engineUrl}/api/checklists/templates/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    await loadTemplates();
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Checklist Templates</h1>
      <p class="text-base-content/60 text-sm mt-1">Reusable checklist definitions</p>
    </div>
    <button class="btn btn-primary btn-sm" onclick={() => (showCreateModal = true)}>+ New Template</button>
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
  {:else if templates.length === 0}
    <div class="card bg-base-200 text-center py-12">
      <p class="text-base-content/60">No templates yet</p>
      <button class="btn btn-primary btn-sm mt-4" onclick={() => (showCreateModal = true)}>Create Template</button>
    </div>
  {:else}
    <div class="space-y-3">
      {#each templates as tpl}
        <div class="card bg-base-200">
          <div class="card-body p-4">
            <div class="flex items-start justify-between">
              <div>
                <h3 class="font-semibold">{tpl.name}</h3>
                {#if tpl.collection}
                  <p class="text-sm text-base-content/60">Collection: <code>{tpl.collection}</code></p>
                {:else}
                  <p class="text-sm text-base-content/40">Global template</p>
                {/if}
                {#if tpl.description}
                  <p class="text-sm text-base-content/50 mt-1">{tpl.description}</p>
                {/if}
              </div>
              <button onclick={() => deleteTemplate(tpl.id)} class="btn btn-ghost btn-xs text-error">Delete</button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if showCreateModal}
  <dialog class="modal modal-open">
    <div class="modal-box w-11/12 max-w-xl">
      <h3 class="font-bold text-lg mb-4">Create Template</h3>

      <div class="space-y-3 mb-4">
        <div class="form-control">
          <label class="label"><span class="label-text">Template name</span></label>
          <input type="text" bind:value={form.name} class="input input-bordered" />
        </div>
        <div class="form-control">
          <label class="label"><span class="label-text">Collection (optional)</span></label>
          <input type="text" bind:value={form.collection} placeholder="Leave blank for global" class="input input-bordered input-sm" />
        </div>
      </div>

      <div class="mb-4">
        <div class="flex items-center justify-between mb-2">
          <label class="label-text font-medium">Items</label>
          <button class="btn btn-ghost btn-xs" onclick={addItem}>+ Add item</button>
        </div>
        <div class="space-y-2">
          {#each form.items as item, i}
            <div class="flex gap-2 items-center">
              <input type="text" bind:value={item.label} placeholder="Item label" class="input input-bordered input-sm flex-1" />
              <label class="label cursor-pointer gap-1">
                <span class="label-text text-xs">Required</span>
                <input type="checkbox" bind:checked={item.required} class="checkbox checkbox-xs" />
              </label>
              {#if form.items.length > 1}
                <button onclick={() => removeItem(i)} class="btn btn-ghost btn-xs text-error">✕</button>
              {/if}
            </div>
          {/each}
        </div>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={createTemplate} disabled={creating}>
          {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
          Create
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
  </dialog>
{/if}
