<script lang="ts">
 import { onMount } from 'svelte';
 import { page } from '$app/state';
 import { collectionsApi, api } from '$lib/api.js';
 import { ArrowLeft, Plus, Trash2, GripVertical, ChevronDown } from '@lucide/svelte';
 import { base } from '$app/paths';

 const collectionName = $derived(page.params.name);
 let collection = $state<any>(null);
 let fieldTypes = $state<any[]>([]);
 let loading = $state(true);
 let saving = $state(false);
 let showAddForm = $state(false);

 // New field form state
 let newField = $state({
 name: '',
 type: 'text',
 label: '',
 required: false,
 unique: false,
 indexed: false,
 description: '',
 });

 let addError = $state('');

 onMount(async () => {
 const [colRes, typesRes] = await Promise.all([
 collectionsApi.get(collectionName),
 collectionsApi.fieldTypes(),
 ]);
 collection = colRes.collection;
 fieldTypes = typesRes.field_types;
 loading = false;
 });

 function getFields(): any[] {
 if (!collection) return [];
 const f = collection.fields;
 return typeof f === 'string' ? JSON.parse(f) : f || [];
 }

 function getCategoryTypes(category: string) {
 return fieldTypes.filter((t) => t.category === category);
 }

 const categories = [
 { id: 'text', label: 'Text' },
 { id: 'number', label: 'Number' },
 { id: 'date', label: 'Date & Time' },
 { id: 'media', label: 'Media' },
 { id: 'relation', label: 'Relations' },
 { id: 'location', label: 'Location' },
 { id: 'special', label: 'Special' },
 ];

 async function addField() {
 addError = '';
 if (!newField.name.trim()) { addError = 'Field name is required'; return; }
 if (!/^[a-z][a-z0-9_]*$/.test(newField.name)) {
 addError = 'Field name must start with a letter and contain only lowercase letters, digits, underscores';
 return;
 }

 const existing = getFields().find((f: any) => f.name === newField.name);
 if (existing) { addError = `Field '${newField.name}' already exists`; return; }

 saving = true;
 try {
 await api.post(`/api/collections/${collectionName}/fields`, {
 ...newField,
 label: newField.label || newField.name,
 });
 const res = await collectionsApi.get(collectionName);
 collection = res.collection;
 showAddForm = false;
 newField = { name: '', type: 'text', label: '', required: false, unique: false, indexed: false, description: '' };
 } catch (err: any) {
 addError = err.message || 'Failed to add field';
 } finally {
 saving = false;
 }
 }

 async function deleteField(fieldName: string) {
 if (!confirm(`Delete field '${fieldName}'? This will DROP the column and all its data.`)) return;
 saving = true;
 try {
 await api.delete(`/api/collections/${collectionName}/fields/${fieldName}`);
 const res = await collectionsApi.get(collectionName);
 collection = res.collection;
 } catch (err: any) {
 alert(err.message);
 } finally {
 saving = false;
 }
 }
</script>

<div class="space-y-6">
 <!-- Header -->
 <div class="flex items-center gap-3">
 <a href="{base}/collections/{collectionName}" class="btn btn-ghost btn-sm">
 <ArrowLeft size={16} />
 </a>
 <div>
 <h1 class="text-2xl font-bold">
 {collection?.display_name || collectionName}
 <span class="text-base-content/40 font-normal">/ Fields</span>
 </h1>
 <p class="text-base-content/60 text-sm">Manage the schema for this collection</p>
 </div>
 <div class="ml-auto">
 <button class="btn btn-primary btn-sm" onclick={() => (showAddForm = !showAddForm)}>
 <Plus size={16} />
 Add Field
 </button>
 </div>
 </div>

 <!-- Add field form -->
 {#if showAddForm}
 <div class="card bg-base-200 border border-primary/30">
 <div class="card-body gap-4">
 <h3 class="font-semibold">New Field</h3>

 <div class="grid grid-cols-2 gap-4">
 <div class="form-control">
 <label class="label" for="field_name">
 <span class="label-text">Field name <span class="text-error">*</span></span>
 </label>
 <input
 id="field_name"
 type="text"
 bind:value={newField.name}
 placeholder="e.g. product_name"
 class="input input-sm font-mono"
 />
 <label class="label">
 <span class="label-text-alt text-base-content/50">lowercase_with_underscores</span>
 </label>
 </div>

 <div class="form-control">
 <label class="label" for="field_label"><span class="label-text">Display label</span></label>
 <input
 id="field_label"
 type="text"
 bind:value={newField.label}
 placeholder="e.g. Product Name"
 class="input input-sm"
 />
 </div>
 </div>

 <!-- Type selector grouped by category -->
 <div class="form-control">
 <label class="label"><span class="label-text">Field type</span></label>
 <div class="grid grid-cols-2 gap-3">
 {#each categories as cat}
 {@const types = getCategoryTypes(cat.id)}
 {#if types.length > 0}
 <div>
 <p class="text-xs font-semibold text-base-content/50 uppercase mb-1">{cat.label}</p>
 <div class="flex flex-wrap gap-1">
 {#each types as ft}
 <button
 type="button"
 class="badge badge-sm cursor-pointer {newField.type === ft.type ? 'badge-primary' : 'badge-outline'}"
 onclick={() => (newField.type = ft.type)}
 title={ft.description || ft.label}
 >
 {ft.label}
 </button>
 {/each}
 </div>
 </div>
 {/if}
 {/each}
 </div>
 </div>

 <div class="flex gap-4">
 <label class="flex items-center gap-2 cursor-pointer">
 <input type="checkbox" bind:checked={newField.required} class="checkbox checkbox-sm" />
 <span class="label-text">Required</span>
 </label>
 <label class="flex items-center gap-2 cursor-pointer">
 <input type="checkbox" bind:checked={newField.unique} class="checkbox checkbox-sm" />
 <span class="label-text">Unique</span>
 </label>
 <label class="flex items-center gap-2 cursor-pointer">
 <input type="checkbox" bind:checked={newField.indexed} class="checkbox checkbox-sm" />
 <span class="label-text">Indexed</span>
 </label>
 </div>

 {#if addError}
 <p class="text-error text-sm">{addError}</p>
 {/if}

 <div class="flex gap-2">
 <button class="btn btn-primary btn-sm" onclick={addField} disabled={saving}>
 {saving ? 'Adding…' : 'Add Field'}
 </button>
 <button class="btn btn-ghost btn-sm" onclick={() => { showAddForm = false; addError = ''; }}>
 Cancel
 </button>
 </div>
 </div>
 </div>
 {/if}

 {#if loading}
 <div class="flex justify-center py-12">
 <span class="loading loading-spinner loading-lg"></span>
 </div>
 {:else}
 <!-- User-defined fields -->
 <div class="space-y-2">
 <h2 class="text-sm font-semibold text-base-content/60 uppercase tracking-wider">
 Custom Fields ({getFields().length})
 </h2>

 {#each getFields() as field}
 <div class="card bg-base-200 hover:bg-base-300 transition-colors">
 <div class="card-body p-4 flex-row items-center gap-4">
 <GripVertical size={16} class="text-base-content/20 cursor-grab shrink-0" />

 <div class="flex-1 min-w-0">
 <div class="flex items-center gap-2 flex-wrap">
 <span class="font-mono font-semibold">{field.name}</span>
 {#if field.label && field.label !== field.name}
 <span class="text-base-content/50 text-sm">{field.label}</span>
 {/if}
 <span class="badge badge-outline badge-sm">{field.type}</span>
 {#if field.required}
 <span class="badge badge-warning badge-sm">required</span>
 {/if}
 {#if field.unique}
 <span class="badge badge-info badge-sm">unique</span>
 {/if}
 {#if field.indexed}
 <span class="badge badge-ghost badge-sm">indexed</span>
 {/if}
 </div>
 {#if field.description}
 <p class="text-xs text-base-content/50 mt-0.5">{field.description}</p>
 {/if}
 </div>

 <button
 onclick={() => deleteField(field.name)}
 class="btn btn-ghost btn-xs text-error shrink-0"
 title="Delete field"
 >
 <Trash2 size={14} />
 </button>
 </div>
 </div>
 {/each}

 {#if getFields().length === 0}
 <div class="text-center py-8 text-base-content/40">
 <p>No custom fields yet. Add your first field above.</p>
 </div>
 {/if}
 </div>

 <!-- System fields (read-only) -->
 <div class="space-y-2">
 <h2 class="text-sm font-semibold text-base-content/60 uppercase tracking-wider">
 System Fields (auto-managed)
 </h2>
 <div class="overflow-x-auto">
 <table class="table table-sm opacity-60">
 <thead>
 <tr>
 <th>Name</th>
 <th>Type</th>
 <th>Notes</th>
 </tr>
 </thead>
 <tbody>
 {#each [
 { name: 'id', type: 'UUID', notes: 'Primary key, auto-generated' },
 { name: 'created_at', type: 'TIMESTAMPTZ', notes: 'Set on insert' },
 { name: 'updated_at', type: 'TIMESTAMPTZ', notes: 'Updated on every save' },
 { name: 'status', type: 'TEXT', notes: "Default: 'published'" },
 { name: 'created_by', type: 'TEXT', notes: 'User ID who created' },
 { name: 'updated_by', type: 'TEXT', notes: 'User ID who last updated' },
 ] as sys}
 <tr>
 <td><code>{sys.name}</code></td>
 <td class="font-mono text-xs">{sys.type}</td>
 <td class="text-xs text-base-content/50">{sys.notes}</td>
 </tr>
 {/each}
 </tbody>
 </table>
 </div>
 </div>
 {/if}
</div>
