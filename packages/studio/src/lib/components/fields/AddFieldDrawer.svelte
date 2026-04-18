<script lang="ts">
  import { X, Type, Hash, Calendar, Image, Link, MapPin, Cpu, Database, ChevronRight } from '@lucide/svelte';

  let {
    open = $bindable(false),
    fieldTypes = [] as any[],
    allCollections = [] as any[],
    collectionName = '',
    onsave,
  }: {
    open: boolean;
    fieldTypes: any[];
    allCollections: any[];
    collectionName: string;
    onsave: (field: any) => Promise<void>;
  } = $props();

  const categories = [
    { id: 'text',     label: 'Text',       Icon: Type },
    { id: 'number',   label: 'Number',     Icon: Hash },
    { id: 'date',     label: 'Date & Time',Icon: Calendar },
    { id: 'media',    label: 'Media',      Icon: Image },
    { id: 'relation', label: 'Relations',  Icon: Link },
    { id: 'location', label: 'Location',   Icon: MapPin },
    { id: 'special',  label: 'Special',    Icon: Cpu },
    { id: 'advanced', label: 'Advanced',   Icon: Database },
  ];

  const RELATION_NEEDS_TARGET = new Set(['m2o', 'reference', 'o2m', 'm2m']);

  let selectedCategory = $state('text');
  let saving = $state(false);
  let error = $state('');

  let form = $state({
    name: '',
    type: 'text',
    label: '',
    description: '',
    required: false,
    unique: false,
    indexed: false,
    related_collection: '',
    enum_values_raw: '',
  });

  function visibleTypes() {
    return fieldTypes.filter((t) => t.category === selectedCategory);
  }

  function selectType(type: string) {
    form.type = type;
    // auto-pick first available category that has this type, if current doesn't
  }

  function close() {
    open = false;
    error = '';
  }

  function reset() {
    form = { name: '', type: 'text', label: '', description: '', required: false, unique: false, indexed: false, related_collection: '', enum_values_raw: '' };
    selectedCategory = 'text';
    error = '';
  }

  $effect(() => {
    if (!open) reset();
  });

  function parseEnumValues(raw: string): string[] {
    return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }

  async function submit() {
    error = '';

    if (!form.name.trim()) { error = 'Field name is required'; return; }
    if (!/^[a-z][a-z0-9_]*$/.test(form.name)) {
      error = 'Field name must start with a lowercase letter and contain only lowercase letters, digits, underscores';
      return;
    }
    if (RELATION_NEEDS_TARGET.has(form.type) && !form.related_collection) {
      error = 'Please select a target collection for this relation field';
      return;
    }

    let enumValues: string[] = [];
    if (form.type === 'enum') {
      enumValues = parseEnumValues(form.enum_values_raw);
      if (enumValues.length === 0) {
        error = 'Enum fields need at least one value';
        return;
      }
    }

    saving = true;
    try {
      const body: Record<string, any> = {
        name: form.name,
        type: form.type,
        label: form.label || form.name,
        description: form.description || undefined,
        required: form.required,
        unique: form.unique,
        indexed: form.indexed,
      };
      const options: Record<string, any> = {};
      if (form.related_collection) options.related_collection = form.related_collection;
      if (enumValues.length > 0) options.values = enumValues;
      if (Object.keys(options).length > 0) body.options = options;

      await onsave(body);
      close();
    } catch (e: any) {
      error = e.message || 'Failed to add field';
    } finally {
      saving = false;
    }
  }

  // Keep selectedCategory in sync when type changes externally
  $effect(() => {
    const def = fieldTypes.find((t) => t.type === form.type);
    if (def?.category && def.category !== selectedCategory) {
      // don't auto-switch category, user picked type explicitly
    }
  });
</script>

<!-- Overlay -->
<div
  class="fixed inset-0 z-50 {open ? '' : 'pointer-events-none'}"
  aria-hidden={!open}
>
  <!-- Backdrop -->
  <div
    class="absolute inset-0 bg-black/40 transition-opacity duration-300 {open ? 'opacity-100' : 'opacity-0'}"
    onclick={close}
    role="presentation"
  ></div>

  <!-- Panel -->
  <div
    class="absolute inset-y-0 right-0 flex flex-col w-full max-w-[540px] bg-base-100 shadow-2xl transition-transform duration-300 {open ? 'translate-x-0' : 'translate-x-full'}"
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-5 py-4 border-b border-base-200 shrink-0">
      <div>
        <h2 class="font-semibold text-lg">Add Field</h2>
        <p class="text-xs text-base-content/50 mt-0.5">to <span class="font-mono">{collectionName}</span></p>
      </div>
      <button class="btn btn-ghost btn-sm btn-square" onclick={close} aria-label="Close">
        <X size={18} />
      </button>
    </div>

    <!-- Scrollable body -->
    <div class="flex-1 overflow-y-auto">
      <!-- ── Type Picker ─────────────────────────────────── -->
      <div class="border-b border-base-200 bg-base-200/40">
        <!-- Category tabs -->
        <div class="flex overflow-x-auto gap-0 px-4 pt-3">
          {#each categories as cat}
            {@const count = fieldTypes.filter((t) => t.category === cat.id).length}
            {#if count > 0}
              <button
                type="button"
                class="flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors
                  {selectedCategory === cat.id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-base-content/50 hover:text-base-content hover:border-base-content/20'}"
                onclick={() => (selectedCategory = cat.id)}
              >
                <cat.Icon size={13} />
                {cat.label}
                <span class="badge badge-xs {selectedCategory === cat.id ? 'badge-primary' : 'badge-ghost'}">{count}</span>
              </button>
            {/if}
          {/each}
        </div>

        <!-- Type cards grid -->
        <div class="grid grid-cols-3 gap-2 p-4">
          {#each visibleTypes() as ft}
            <button
              type="button"
              class="text-left p-3 rounded-xl border-2 transition-all cursor-pointer
                {form.type === ft.type
                  ? 'border-primary bg-primary/8 text-primary'
                  : 'border-base-200 bg-base-100 hover:border-primary/40 hover:bg-base-200'}"
              onclick={() => selectType(ft.type)}
              title={ft.description || ft.label}
            >
              <p class="font-semibold text-sm leading-tight">{ft.label}</p>
              {#if ft.description}
                <p class="text-xs text-base-content/40 mt-0.5 line-clamp-2 leading-tight">{ft.description}</p>
              {:else}
                <p class="text-xs text-base-content/30 mt-0.5 font-mono">{ft.type}</p>
              {/if}
            </button>
          {/each}
        </div>

        <!-- Selected type badge -->
        <div class="px-4 pb-3 flex items-center gap-2">
          <ChevronRight size={13} class="text-base-content/30" />
          <span class="text-xs text-base-content/50">Selected:</span>
          <span class="badge badge-primary badge-sm font-mono">{form.type}</span>
          {#if fieldTypes.find((t) => t.type === form.type)?.description}
            <span class="text-xs text-base-content/40">{fieldTypes.find((t) => t.type === form.type)?.description}</span>
          {/if}
        </div>
      </div>

      <!-- ── Configuration ───────────────────────────────── -->
      <div class="p-5 space-y-4">
        <h3 class="text-sm font-semibold text-base-content/60 uppercase tracking-wider">Configure</h3>

        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-1" for="drawer_field_name">
              <span class="label-text text-xs">Field name <span class="text-error">*</span></span>
            </label>
            <input
              id="drawer_field_name"
              type="text"
              bind:value={form.name}
              placeholder="e.g. product_name"
              class="input input-sm font-mono"
            />
            <div class="label py-0.5">
              <span class="label-text-alt text-base-content/40">lowercase_with_underscores</span>
            </div>
          </div>

          <div class="form-control">
            <label class="label py-1" for="drawer_field_label">
              <span class="label-text text-xs">Display label</span>
            </label>
            <input
              id="drawer_field_label"
              type="text"
              bind:value={form.label}
              placeholder="e.g. Product Name"
              class="input input-sm"
            />
          </div>
        </div>

        <div class="form-control">
          <label class="label py-1" for="drawer_field_desc">
            <span class="label-text text-xs">Description <span class="text-base-content/40">(optional)</span></span>
          </label>
          <input
            id="drawer_field_desc"
            type="text"
            bind:value={form.description}
            placeholder="What does this field store?"
            class="input input-sm"
          />
        </div>

        <!-- Relation target -->
        {#if RELATION_NEEDS_TARGET.has(form.type)}
          <div class="form-control">
            <label class="label py-1" for="drawer_related_col">
              <span class="label-text text-xs">Target collection <span class="text-error">*</span></span>
            </label>
            <select id="drawer_related_col" class="select select-sm" bind:value={form.related_collection}>
              <option value="">— Select collection —</option>
              {#each allCollections as col}
                <option value={col.name}>{col.display_name || col.name}</option>
              {/each}
            </select>
          </div>
        {/if}

        <!-- Enum values -->
        {#if form.type === 'enum'}
          <div class="form-control">
            <label class="label py-1" for="drawer_enum_values">
              <span class="label-text text-xs">Allowed values <span class="text-error">*</span></span>
              <span class="label-text-alt text-base-content/40">comma or newline separated</span>
            </label>
            <textarea
              id="drawer_enum_values"
              class="textarea textarea-sm font-mono"
              rows="3"
              placeholder="active, pending, archived"
              bind:value={form.enum_values_raw}
            ></textarea>
          </div>
        {/if}

        <!-- Constraints -->
        <div class="flex flex-wrap gap-4 pt-1">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" bind:checked={form.required} class="checkbox checkbox-sm checkbox-primary" />
            <span class="label-text text-sm">Required</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" bind:checked={form.unique} class="checkbox checkbox-sm checkbox-secondary" />
            <span class="label-text text-sm">Unique</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" bind:checked={form.indexed} class="checkbox checkbox-sm" />
            <span class="label-text text-sm">Indexed</span>
          </label>
        </div>

        <!-- Error -->
        {#if error}
          <div class="alert alert-error alert-sm py-2 text-sm">
            <span>{error}</span>
          </div>
        {/if}
      </div>
    </div>

    <!-- Footer -->
    <div class="shrink-0 flex items-center justify-end gap-2 px-5 py-4 border-t border-base-200 bg-base-100">
      <button class="btn btn-ghost btn-sm" onclick={close} disabled={saving}>Cancel</button>
      <button class="btn btn-primary btn-sm" onclick={submit} disabled={saving}>
        {saving ? 'Adding…' : 'Add Field'}
      </button>
    </div>
  </div>
</div>
