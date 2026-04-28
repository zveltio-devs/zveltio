<script lang="ts">
  import {
    X, Plus, Type, Pilcrow, FileText, Mail, Lock, Hash, Link2, Phone,
    Calendar, Clock, Image, File, GitBranch, Network, Share2, MapPin,
    Braces, ToggleLeft, List, ScanLine, Binary, Database, Layers,
    SquareCheck, Barcode, Globe, StickyNote,
  } from '@lucide/svelte';

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

  // Category definitions with icons and colors
  const categories = [
    { id: 'text',     label: 'Text',        Icon: Type,        color: 'text-blue-500' },
    { id: 'number',   label: 'Number',      Icon: Hash,        color: 'text-green-500' },
    { id: 'date',     label: 'Date & Time', Icon: Calendar,    color: 'text-orange-500' },
    { id: 'media',    label: 'Media',       Icon: Image,       color: 'text-purple-500' },
    { id: 'relation', label: 'Relations',   Icon: GitBranch,   color: 'text-pink-500' },
    { id: 'location', label: 'Location',    Icon: MapPin,      color: 'text-teal-500' },
    { id: 'special',  label: 'Special',     Icon: Layers,      color: 'text-yellow-500' },
    { id: 'advanced', label: 'Advanced',    Icon: Database,    color: 'text-gray-500' },
  ];

  // Per-type icons for the grid cards
  const TYPE_ICONS: Record<string, any> = {
    text:        Type,
    longtext:    Pilcrow,
    richtext:    FileText,
    email:       Mail,
    password:    Lock,
    slug:        Barcode,
    url:         Globe,
    phone:       Phone,
    int:         Hash,
    float:       Binary,
    decimal:     Binary,
    number:      Hash,
    boolean:     ToggleLeft,
    checkbox:    SquareCheck,
    date:        Calendar,
    time:        Clock,
    datetime:    Calendar,
    timestamp:   Clock,
    image:       Image,
    file:        File,
    m2o:         GitBranch,
    o2m:         Network,
    m2m:         Share2,
    reference:   Link2,
    location:    MapPin,
    json:        Braces,
    jsonb:       Braces,
    enum:        List,
    uuid:        ScanLine,
    text_array:  Layers,
    note:        StickyNote,
  };

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

  const visibleTypes = $derived(fieldTypes.filter((t) => t.category === selectedCategory));

  const selectedTypeDef = $derived(fieldTypes.find((t) => t.type === form.type));

  function selectType(type: string) {
    form.type = type;
    // auto-switch category to match the selected type
    const def = fieldTypes.find((t) => t.type === type);
    if (def?.category) selectedCategory = def.category;
  }

  function close() {
    open = false;
    error = '';
  }

  function reset() {
    form = {
      name: '', type: 'text', label: '', description: '',
      required: false, unique: false, indexed: false,
      related_collection: '', enum_values_raw: '',
    };
    selectedCategory = 'text';
    error = '';
  }

  $effect(() => {
    if (!open) reset();
  });

  // Auto-select first type of a category when switching
  $effect(() => {
    const typesInCat = fieldTypes.filter((t) => t.category === selectedCategory);
    if (typesInCat.length > 0 && !typesInCat.some((t) => t.type === form.type)) {
      form.type = typesInCat[0].type;
    }
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
      if (enumValues.length === 0) { error = 'Enum fields need at least one value'; return; }
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
</script>

<!-- Full-screen overlay -->
<div
  class="fixed inset-0 z-50 flex flex-col {open ? '' : 'pointer-events-none'}"
  aria-modal="true"
  role="dialog"
  aria-hidden={!open}
>
  <!-- Backdrop -->
  <div
    class="absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-200 {open ? 'opacity-100' : 'opacity-0'}"
    onclick={close}
    role="presentation"
  ></div>

  <!-- Full-screen panel -->
  <div
    class="absolute inset-4 md:inset-6 lg:inset-8 flex flex-col bg-base-100 rounded-2xl shadow-2xl overflow-hidden
           transition-all duration-200 {open ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}"
  >
    <!-- ── Header ─────────────────────────────────────────────── -->
    <div class="flex items-center justify-between px-6 py-4 border-b border-base-200 shrink-0">
      <div class="flex items-center gap-3">
        <div class="bg-primary/10 p-2 rounded-lg shrink-0">
          <Plus size={20} class="text-primary" />
        </div>
        <div>
          <h2 class="font-bold text-lg leading-tight">Add Field</h2>
          <p class="text-xs text-base-content/50 mt-0.5">
            to collection <span class="font-mono text-primary font-medium">{collectionName}</span>
          </p>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm btn-square" onclick={close} aria-label="Close">
        <X size={18} />
      </button>
    </div>

    <!-- ── Body ──────────────────────────────────────────────── -->
    <div class="flex-1 flex overflow-hidden">

      <!-- Left sidebar: categories -->
      <aside class="w-52 shrink-0 border-r border-base-200 bg-base-200/30 flex flex-col py-3 px-2 gap-0.5 overflow-y-auto">
        <p class="px-3 pb-2 text-[10px] font-semibold uppercase tracking-widest text-base-content/40">Category</p>
        {#each categories as cat}
          {@const count = fieldTypes.filter((t) => t.category === cat.id).length}
          {#if count > 0}
            <button
              type="button"
              class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all text-left
                {selectedCategory === cat.id
                  ? 'bg-primary text-primary-content font-semibold shadow-sm'
                  : 'text-base-content/60 hover:bg-base-200 hover:text-base-content'}"
              onclick={() => (selectedCategory = cat.id)}
            >
              <cat.Icon
                size={18}
                class={(selectedCategory === cat.id ? 'text-primary-content' : cat.color) + ' shrink-0'}
              />
              <span class="flex-1 truncate">{cat.label}</span>
              <span class="badge badge-xs shrink-0
                {selectedCategory === cat.id
                  ? 'bg-primary-content/20 text-primary-content border-0'
                  : 'badge-ghost'}">
                {count}
              </span>
            </button>
          {/if}
        {/each}
      </aside>

      <!-- Right panel: type grid + config form -->
      <div class="flex-1 overflow-y-auto">

        <!-- Type grid section -->
        <div class="px-6 pt-5">
          <div class="flex items-center gap-2 mb-4">
            {#each categories as cat}{#if cat.id === selectedCategory}
              <cat.Icon size={16} class={cat.color} />
            {/if}{/each}
            <h3 class="text-sm font-semibold text-base-content/70">
              {categories.find((c) => c.id === selectedCategory)?.label ?? ''} Fields
            </h3>
          </div>

          <div class="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {#each visibleTypes as ft}
              {@const TypeIcon = TYPE_ICONS[ft.type] ?? Database}
              <button
                type="button"
                class="group text-left p-4 rounded-xl border-2 transition-all duration-150
                  {form.type === ft.type
                    ? 'border-primary bg-primary/6 shadow-sm ring-1 ring-primary/20'
                    : 'border-base-200 bg-base-100 hover:border-primary/50 hover:shadow-sm'}"
                onclick={() => selectType(ft.type)}
                title={ft.description || ft.label}
              >
                <TypeIcon
                  size={22}
                  class={'mb-2.5 transition-colors ' + (form.type === ft.type
                    ? 'text-primary'
                    : 'text-base-content/30 group-hover:text-base-content/60')}
                />
                <p class="font-semibold text-sm leading-tight {form.type === ft.type ? 'text-primary' : ''}">
                  {ft.label}
                </p>
                {#if ft.description}
                  <p class="text-xs text-base-content/40 mt-1 leading-relaxed line-clamp-3">
                    {ft.description}
                  </p>
                {:else}
                  <p class="text-xs font-mono text-base-content/30 mt-1">{ft.type}</p>
                {/if}
              </button>
            {/each}
          </div>
        </div>

        <!-- Divider -->
        <div class="mx-6 my-5 border-t border-base-200"></div>

        <!-- Configuration form -->
        <div class="px-6 pb-6 space-y-4">
          <!-- Section title + selected type chip -->
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold text-base-content/50 uppercase tracking-wider">Configure</h3>
            <span class="badge badge-primary badge-sm font-mono">{form.type}</span>
            {#if selectedTypeDef?.description}
              <span class="text-xs text-base-content/40 hidden sm:inline">{selectedTypeDef.description}</span>
            {/if}
          </div>

          <!-- Name + Label row -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="form-control">
              <label class="label py-1" for="afd_name">
                <span class="label-text text-xs font-medium">
                  Field name <span class="text-error">*</span>
                </span>
              </label>
              <input
                id="afd_name"
                type="text"
                bind:value={form.name}
                placeholder="e.g. product_name"
                class="input input-sm font-mono"
                autocomplete="off"
              />
              <div class="label py-0.5">
                <span class="label-text-alt text-base-content/40 text-[11px]">lowercase_with_underscores</span>
              </div>
            </div>

            <div class="form-control">
              <label class="label py-1" for="afd_label">
                <span class="label-text text-xs font-medium">Display label</span>
              </label>
              <input
                id="afd_label"
                type="text"
                bind:value={form.label}
                placeholder="e.g. Product Name"
                class="input input-sm"
              />
              <div class="label py-0.5">
                <span class="label-text-alt text-base-content/40 text-[11px]">Shown in Studio (optional)</span>
              </div>
            </div>
          </div>

          <!-- Description -->
          <div class="form-control">
            <label class="label py-1" for="afd_desc">
              <span class="label-text text-xs font-medium">Description <span class="text-base-content/40">(optional)</span></span>
            </label>
            <input
              id="afd_desc"
              type="text"
              bind:value={form.description}
              placeholder="What does this field store?"
              class="input input-sm"
            />
          </div>

          <!-- Relation target -->
          {#if RELATION_NEEDS_TARGET.has(form.type)}
            <div class="form-control">
              <label class="label py-1" for="afd_related">
                <span class="label-text text-xs font-medium">
                  Target collection <span class="text-error">*</span>
                </span>
              </label>
              <select id="afd_related" class="select select-sm" bind:value={form.related_collection}>
                <option value="">— Select collection —</option>
                {#each allCollections as col}
                  <option value={col.name}>{col.display_name || col.name}</option>
                {/each}
              </select>
              <div class="label py-0.5">
                <span class="label-text-alt text-base-content/40 text-[11px]">
                  {form.type === 'o2m'
                    ? 'The collection that has many records pointing back here'
                    : form.type === 'm2m'
                    ? 'The other side of the junction table'
                    : 'The collection this field references'}
                </span>
              </div>
            </div>
          {/if}

          <!-- Enum values -->
          {#if form.type === 'enum'}
            <div class="form-control">
              <label class="label py-1" for="afd_enum">
                <span class="label-text text-xs font-medium">
                  Allowed values <span class="text-error">*</span>
                </span>
                <span class="label-text-alt text-base-content/40 text-[11px]">comma or newline separated</span>
              </label>
              <textarea
                id="afd_enum"
                class="textarea textarea-sm font-mono text-sm"
                rows="3"
                placeholder="active, pending, archived"
                bind:value={form.enum_values_raw}
              ></textarea>
              {#if form.enum_values_raw}
                <div class="label py-1 flex-wrap gap-1">
                  {#each parseEnumValues(form.enum_values_raw) as v}
                    <span class="badge badge-xs badge-ghost font-mono">{v}</span>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          <!-- Constraints -->
          <div>
            <p class="text-xs font-medium text-base-content/50 mb-2">Constraints</p>
            <div class="flex flex-wrap gap-6">
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" bind:checked={form.required} class="checkbox checkbox-sm checkbox-error" />
                <div>
                  <span class="label-text text-sm font-medium">Required</span>
                  <p class="text-xs text-base-content/40">Cannot be empty</p>
                </div>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" bind:checked={form.unique} class="checkbox checkbox-sm checkbox-warning" />
                <div>
                  <span class="label-text text-sm font-medium">Unique</span>
                  <p class="text-xs text-base-content/40">No duplicate values</p>
                </div>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" bind:checked={form.indexed} class="checkbox checkbox-sm checkbox-info" />
                <div>
                  <span class="label-text text-sm font-medium">Indexed</span>
                  <p class="text-xs text-base-content/40">Faster queries on this field</p>
                </div>
              </label>
            </div>
          </div>

          <!-- Error -->
          {#if error}
            <div class="alert alert-error py-2.5 text-sm">
              <X size={16} />
              <span>{error}</span>
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- ── Footer ─────────────────────────────────────────────── -->
    <div class="shrink-0 flex items-center justify-between px-6 py-4 border-t border-base-200 bg-base-100">
      <div class="text-xs text-base-content/40 hidden sm:block">
        {#if form.name}
          <span class="font-mono text-base-content/70">{form.name}</span>
          <span class="mx-1">·</span>
          <span class="badge badge-outline badge-xs font-mono">{form.type}</span>
          {#if form.required}<span class="badge badge-error badge-xs ml-1">required</span>{/if}
          {#if form.unique}<span class="badge badge-warning badge-xs ml-1">unique</span>{/if}
        {:else}
          <span class="italic">Fill in the field name to continue</span>
        {/if}
      </div>
      <div class="flex items-center gap-3 ml-auto">
        <button class="btn btn-ghost btn-sm" onclick={close} disabled={saving}>Cancel</button>
        <button
          class="btn btn-primary btn-sm gap-2"
          onclick={submit}
          disabled={saving || !form.name}
        >
          {#if saving}
            <span class="loading loading-spinner loading-xs"></span>
            Adding…
          {:else}
            <Plus size={15} />
            Add Field
          {/if}
        </button>
      </div>
    </div>
  </div>
</div>
