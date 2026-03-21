<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api } from '$lib/api.js';

  type FieldType = 'text' | 'textarea' | 'email' | 'number' | 'select' | 'multiselect' | 'checkbox' | 'date' | 'file';

  interface FormField {
    id: string;
    type: FieldType;
    label: string;
    required: boolean;
    placeholder?: string;
    options?: string[];
  }

  const PALETTE: { type: FieldType; label: string; icon: string }[] = [
    { type: 'text', label: 'Text', icon: 'T' },
    { type: 'textarea', label: 'Textarea', icon: '¶' },
    { type: 'email', label: 'Email', icon: '@' },
    { type: 'number', label: 'Number', icon: '#' },
    { type: 'select', label: 'Select', icon: '▾' },
    { type: 'multiselect', label: 'Multi-select', icon: '☑' },
    { type: 'checkbox', label: 'Checkbox', icon: '✓' },
    { type: 'date', label: 'Date', icon: '📅' },
    { type: 'file', label: 'File Upload', icon: '↑' },
  ];

  let formId = $state<string | null>(null);
  let formName = $state('');
  let formSlug = $state('');
  let formDescription = $state('');
  let targetCollection = $state('');
  let fields = $state<FormField[]>([]);
  let collections = $state<string[]>([]);
  let selectedFieldId = $state<string | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let dragOverIndex = $state<number | null>(null);

  let selectedField = $derived(fields.find((f) => f.id === selectedFieldId) ?? null);

  // Auto-generate slug from name
  function autoSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60);
  }

  function handleNameChange(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    formName = val;
    if (!formId) formSlug = autoSlug(val); // Auto-generate only for new forms
  }

  function addField(type: FieldType) {
    const id = crypto.randomUUID();
    fields = [
      ...fields,
      {
        id,
        type,
        label: PALETTE.find((p) => p.type === type)?.label ?? type,
        required: false,
        placeholder: '',
        options: type === 'select' || type === 'multiselect' ? ['Option 1'] : undefined,
      },
    ];
    selectedFieldId = id;
  }

  function removeField(id: string) {
    fields = fields.filter((f) => f.id !== id);
    if (selectedFieldId === id) selectedFieldId = null;
  }

  function updateField(id: string, updates: Partial<FormField>) {
    fields = fields.map((f) => (f.id === id ? { ...f, ...updates } : f));
  }

  // HTML5 Drag API for palette → canvas
  let draggingPaletteType = $state<FieldType | null>(null);
  let draggingCanvasIndex = $state<number | null>(null);

  function onPaletteDragStart(type: FieldType) {
    draggingPaletteType = type;
    draggingCanvasIndex = null;
  }

  function onCanvasDragStart(index: number) {
    draggingCanvasIndex = index;
    draggingPaletteType = null;
  }

  function onCanvasDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    dragOverIndex = index;
  }

  function onCanvasDrop(e: DragEvent, dropIndex: number) {
    e.preventDefault();
    dragOverIndex = null;

    if (draggingPaletteType !== null) {
      // Add new field at position
      const id = crypto.randomUUID();
      const newField: FormField = {
        id,
        type: draggingPaletteType,
        label: PALETTE.find((p) => p.type === draggingPaletteType)?.label ?? draggingPaletteType,
        required: false,
        placeholder: '',
        options: draggingPaletteType === 'select' || draggingPaletteType === 'multiselect' ? ['Option 1'] : undefined,
      };
      const copy = [...fields];
      copy.splice(dropIndex, 0, newField);
      fields = copy;
      selectedFieldId = id;
      draggingPaletteType = null;
    } else if (draggingCanvasIndex !== null && draggingCanvasIndex !== dropIndex) {
      // Reorder
      const copy = [...fields];
      const [moved] = copy.splice(draggingCanvasIndex, 1);
      copy.splice(dropIndex, 0, moved);
      fields = copy;
      draggingCanvasIndex = null;
    }
  }

  function onCanvasDragLeave() {
    dragOverIndex = null;
  }

  async function save(publish = false) {
    if (!formName.trim()) return alert('Form name is required');
    if (!formSlug.trim()) return alert('Slug is required');
    saving = true;
    try {
      const payload = {
        name: formName,
        slug: formSlug,
        description: formDescription || undefined,
        fields,
        target_collection: targetCollection || undefined,
        active: publish,
      };
      if (formId) {
        await api.patch(`/extensions/forms/forms/${formId}`, payload);
      } else {
        const res = await api.post('/extensions/forms/forms', payload);
        formId = res.form?.id;
      }
      goto('/admin/forms');
    } catch (e: any) {
      alert('Save failed: ' + (e.message ?? ''));
    } finally {
      saving = false;
    }
  }

  onMount(async () => {
    const id = $page.params.id;
    if (id && id !== 'new') {
      formId = id;
      loading = true;
      try {
        const res = await api.get(`/extensions/forms/forms/${id}`);
        const f = res.form;
        formName = f.name;
        formSlug = f.slug;
        formDescription = f.description ?? '';
        targetCollection = f.target_collection ?? '';
        fields = typeof f.fields === 'string' ? JSON.parse(f.fields) : (f.fields ?? []);
      } catch (e: any) {
        error = e.message ?? 'Failed to load form';
      } finally {
        loading = false;
      }
    }

    try {
      const colRes = await api.get('/api/collections');
      collections = (colRes.collections ?? []).map((c: any) => c.name);
    } catch {
      // ignore
    }
  });
</script>

<div class="builder-page">
  <div class="builder-header">
    <button class="btn-back" onclick={() => goto('/admin/forms')}>← Back</button>
    <h1>{formId ? 'Edit Form' : 'New Form'}</h1>
    <div class="header-actions">
      <button class="btn-save" onclick={() => save(false)} disabled={saving}>Save Draft</button>
      <button class="btn-publish" onclick={() => save(true)} disabled={saving}>Publish</button>
    </div>
  </div>

  {#if loading}
    <p class="loading">Loading…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else}
    <div class="builder-layout">
      <!-- Left: Palette -->
      <aside class="palette">
        <h3>Field Types</h3>
        {#each PALETTE as item}
          <div
            class="palette-item"
            draggable="true"
            ondragstart={() => onPaletteDragStart(item.type)}
            ondblclick={() => addField(item.type)}
            title="Double-click or drag to add"
          >
            <span class="palette-icon">{item.icon}</span>
            <span>{item.label}</span>
          </div>
        {/each}
      </aside>

      <!-- Center: Canvas -->
      <main class="canvas">
        <div class="form-meta">
          <input
            type="text"
            class="input-name"
            placeholder="Form name"
            value={formName}
            oninput={handleNameChange}
          />
          <input
            type="text"
            class="input-slug"
            placeholder="slug (auto-generated)"
            bind:value={formSlug}
          />
          <textarea
            class="input-desc"
            placeholder="Description (optional)"
            bind:value={formDescription}
            rows="2"
          ></textarea>
          <div class="target-row">
            <label>Target collection:</label>
            <select bind:value={targetCollection}>
              <option value="">None (submissions only)</option>
              {#each collections as col}
                <option value={col}>{col}</option>
              {/each}
            </select>
          </div>
        </div>

        <div
          class="fields-canvas"
          ondragover={(e) => e.preventDefault()}
          ondragleave={onCanvasDragLeave}
        >
          {#if fields.length === 0}
            <div
              class="canvas-empty"
              ondragover={(e) => { e.preventDefault(); dragOverIndex = 0; }}
              ondrop={(e) => onCanvasDrop(e, 0)}
            >
              Drag fields here or double-click palette items to add
            </div>
          {:else}
            {#each fields as field, i}
              <div
                class="canvas-field"
                class:selected={selectedFieldId === field.id}
                class:drag-over={dragOverIndex === i}
                draggable="true"
                ondragstart={() => onCanvasDragStart(i)}
                ondragover={(e) => onCanvasDragOver(e, i)}
                ondrop={(e) => onCanvasDrop(e, i)}
                onclick={() => { selectedFieldId = field.id; }}
                role="button"
                tabindex="0"
                onkeydown={(e) => e.key === 'Enter' && (selectedFieldId = field.id)}
              >
                <span class="field-drag-handle">⋮⋮</span>
                <div class="field-preview">
                  <label>
                    {field.label}
                    {#if field.required}<span class="required-star">*</span>{/if}
                  </label>
                  {#if field.type === 'text' || field.type === 'email' || field.type === 'number'}
                    <input type={field.type} placeholder={field.placeholder} disabled />
                  {:else if field.type === 'textarea'}
                    <textarea placeholder={field.placeholder} disabled rows="2"></textarea>
                  {:else if field.type === 'select'}
                    <select disabled>
                      {#each field.options ?? [] as opt}
                        <option>{opt}</option>
                      {/each}
                    </select>
                  {:else if field.type === 'checkbox'}
                    <input type="checkbox" disabled />
                  {:else if field.type === 'date'}
                    <input type="date" disabled />
                  {:else}
                    <div class="field-type-badge">{field.type}</div>
                  {/if}
                </div>
                <button
                  class="remove-field"
                  onclick={(e) => { e.stopPropagation(); removeField(field.id); }}
                  aria-label="Remove field"
                >✕</button>
              </div>
            {/each}
            <!-- Drop zone at end -->
            <div
              class="canvas-drop-end"
              ondragover={(e) => { e.preventDefault(); dragOverIndex = fields.length; }}
              ondrop={(e) => onCanvasDrop(e, fields.length)}
            >Drop here to add at end</div>
          {/if}
        </div>
      </main>

      <!-- Right: Field Config -->
      <aside class="field-config">
        <h3>Field Properties</h3>
        {#if selectedField}
          <div class="config-form">
            <label>Label
              <input
                type="text"
                value={selectedField.label}
                oninput={(e) => updateField(selectedField!.id, { label: (e.target as HTMLInputElement).value })}
              />
            </label>
            <label>Placeholder
              <input
                type="text"
                value={selectedField.placeholder ?? ''}
                oninput={(e) => updateField(selectedField!.id, { placeholder: (e.target as HTMLInputElement).value })}
              />
            </label>
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={selectedField.required}
                onchange={(e) => updateField(selectedField!.id, { required: (e.target as HTMLInputElement).checked })}
              />
              Required
            </label>
            {#if selectedField.type === 'select' || selectedField.type === 'multiselect'}
              <label>Options (one per line)
                <textarea
                  value={(selectedField.options ?? []).join('\n')}
                  oninput={(e) => updateField(selectedField!.id, { options: (e.target as HTMLTextAreaElement).value.split('\n').filter(Boolean) })}
                  rows="5"
                ></textarea>
              </label>
            {/if}
            <div class="field-type-info">
              <strong>Type:</strong> {selectedField.type}
            </div>
          </div>
        {:else}
          <p class="no-selection">Select a field to configure it.</p>
        {/if}
      </aside>
    </div>
  {/if}
</div>

<style>
  .builder-page { height: 100vh; display: flex; flex-direction: column; }
  .builder-header {
    display: flex; align-items: center; gap: 1rem; padding: 0.75rem 1rem;
    border-bottom: 1px solid #e5e7eb; background: white;
  }
  h1 { font-size: 1.25rem; font-weight: 700; flex: 1; }
  h3 { font-size: 0.9rem; font-weight: 600; margin-bottom: 0.75rem; color: #374151; }
  .btn-back { background: none; border: none; cursor: pointer; color: #6366f1; font-size: 0.9rem; }
  .header-actions { display: flex; gap: 0.5rem; }
  .btn-save, .btn-publish {
    padding: 0.4rem 0.9rem; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 0.875rem;
  }
  .btn-save { background: white; border: 1px solid #e5e7eb; color: #374151; }
  .btn-publish { background: #6366f1; border: none; color: white; }
  .btn-publish:hover { background: #4f46e5; }
  .loading, .error { padding: 2rem; }
  .error { color: #ef4444; }
  .builder-layout { display: flex; flex: 1; overflow: hidden; }
  .palette {
    width: 180px; border-right: 1px solid #e5e7eb; padding: 1rem; overflow-y: auto;
    background: #f9fafb;
  }
  .palette-item {
    display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; margin-bottom: 0.4rem;
    border: 1px solid #e5e7eb; border-radius: 6px; cursor: grab; background: white;
    font-size: 0.875rem; user-select: none;
  }
  .palette-item:hover { border-color: #6366f1; background: #ede9fe; }
  .palette-icon { font-size: 1rem; width: 20px; text-align: center; }
  .canvas { flex: 1; overflow-y: auto; padding: 1rem; background: #f3f4f6; }
  .form-meta { background: white; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  .input-name {
    width: 100%; font-size: 1.1rem; font-weight: 600; border: none; border-bottom: 2px solid #e5e7eb;
    padding: 0.25rem 0; margin-bottom: 0.75rem; outline: none;
  }
  .input-name:focus { border-bottom-color: #6366f1; }
  .input-slug, .input-desc {
    width: 100%; padding: 0.35rem 0.5rem; border: 1px solid #e5e7eb; border-radius: 4px;
    font-size: 0.875rem; margin-bottom: 0.5rem; box-sizing: border-box;
  }
  .target-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; }
  .target-row select { flex: 1; padding: 0.35rem; border: 1px solid #e5e7eb; border-radius: 4px; }
  .fields-canvas { min-height: 300px; }
  .canvas-empty {
    border: 2px dashed #d1d5db; border-radius: 8px; padding: 3rem; text-align: center;
    color: #9ca3af; font-size: 0.9rem;
  }
  .canvas-field {
    background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 0.75rem;
    margin-bottom: 0.5rem; cursor: pointer; position: relative; display: flex; align-items: flex-start; gap: 0.5rem;
  }
  .canvas-field.selected { border-color: #6366f1; box-shadow: 0 0 0 2px #6366f133; }
  .canvas-field.drag-over { border-top: 2px solid #6366f1; }
  .field-drag-handle { color: #d1d5db; cursor: grab; user-select: none; font-size: 1.1rem; padding-top: 2px; }
  .field-preview { flex: 1; }
  .field-preview label { display: block; font-size: 0.8rem; font-weight: 600; color: #374151; margin-bottom: 4px; }
  .field-preview input, .field-preview textarea, .field-preview select {
    width: 100%; padding: 0.3rem 0.5rem; border: 1px solid #e5e7eb; border-radius: 4px;
    font-size: 0.8rem; background: #f9fafb; pointer-events: none;
  }
  .field-type-badge { background: #f3f4f6; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; display: inline-block; }
  .required-star { color: #ef4444; margin-left: 2px; }
  .remove-field {
    background: none; border: none; cursor: pointer; color: #9ca3af; font-size: 1rem;
    padding: 0 4px; line-height: 1;
  }
  .remove-field:hover { color: #ef4444; }
  .canvas-drop-end {
    border: 1px dashed #d1d5db; border-radius: 6px; padding: 0.75rem; text-align: center;
    color: #9ca3af; font-size: 0.8rem; margin-top: 0.25rem;
  }
  .field-config {
    width: 240px; border-left: 1px solid #e5e7eb; padding: 1rem; overflow-y: auto; background: white;
  }
  .config-form label { display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem; font-weight: 600; color: #374151; margin-bottom: 0.75rem; }
  .config-form input[type="text"], .config-form textarea, .config-form select {
    padding: 0.35rem 0.5rem; border: 1px solid #e5e7eb; border-radius: 4px; font-size: 0.85rem;
  }
  .checkbox-label { flex-direction: row !important; align-items: center; gap: 0.5rem !important; }
  .field-type-info { font-size: 0.8rem; color: #6b7280; margin-top: 0.5rem; }
  .no-selection { color: #9ca3af; font-size: 0.875rem; }
</style>
