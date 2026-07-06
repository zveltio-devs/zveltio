<script lang="ts">
// Create/Edit record slide-over. Extracted from collections/[name]/+page.svelte
// (H-07 studio split). Self-contained form: the parent passes the collection
// name + the insertable field list and an `onSaved` callback; this component
// owns the drawer open/mode state and exposes `openCreate()` / `openEdit()` so
// the page header + data-table rows can trigger it via `bind:this`.
import { X, Layers, Save, Plus } from '@lucide/svelte';
import { dataApi } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { fieldLabel, fieldBadgeColor, labelFromRecord } from './field-helpers.js';

interface Props {
  collectionName: string;
  // biome-ignore lint/suspicious/noExplicitAny: field shape is dynamic (collection schema)
  insertableFields: any[];
  /** Called after a successful create/update so the parent can reload rows. */
  onSaved: () => void | Promise<void>;
  /** Called from the "no fields → go to Schema" link. */
  onGoToSchema: () => void;
}
const { collectionName, insertableFields, onSaved, onGoToSchema }: Props = $props();

let drawerOpen = $state(false);
let drawerMode = $state<'create' | 'edit'>('create');
let drawerRecordId = $state<string | null>(null);
// biome-ignore lint/suspicious/noExplicitAny: dynamic record form values
let insertForm = $state<Record<string, any>>({});
let inserting = $state(false);
let relOptions = $state<Record<string, { id: string; label: string }[]>>({});
let loadingRelOpts = $state(false);
let formErrors = $state<Record<string, string>>({});

async function loadRelOptions() {
  loadingRelOpts = true;
  const relFields = insertableFields.filter(
    // biome-ignore lint/suspicious/noExplicitAny: dynamic field shape
    (f: any) => (f.type === 'm2o' || f.type === 'reference') && f.options?.related_collection,
  );
  const entries = await Promise.all(
    // biome-ignore lint/suspicious/noExplicitAny: dynamic field shape
    relFields.map(async (f: any) => {
      try {
        const res = await dataApi.list(f.options.related_collection, { limit: '200' });
        return [
          f.name,
          // biome-ignore lint/suspicious/noExplicitAny: dynamic record shape
          (res.records ?? []).map((r: any) => ({ id: r.id, label: labelFromRecord(r) })),
        ] as const;
      } catch {
        return [f.name, [] as { id: string; label: string }[]] as const;
      }
    }),
  );
  relOptions = Object.fromEntries(entries);
  loadingRelOpts = false;
}

export function openCreate() {
  drawerMode = 'create';
  drawerRecordId = null;
  insertForm = {};
  formErrors = {};
  drawerOpen = true;
  loadRelOptions();
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic record shape
export function openEdit(record: any) {
  drawerMode = 'edit';
  drawerRecordId = record.id;
  insertForm = {};
  formErrors = {};
  // Seed the form with current values for editable fields only
  for (const f of insertableFields) {
    const v = record[f.name];
    if (v !== undefined && v !== null) insertForm[f.name] = v;
  }
  drawerOpen = true;
  loadRelOptions();
}

/** Light client-side validation — required fields, basic email/url patterns,
 *  numeric range. Server-side validation still runs and is authoritative. */
function validateForm(): boolean {
  formErrors = {};
  let ok = true;
  for (const f of insertableFields) {
    const v = insertForm[f.name];
    const present = v !== undefined && v !== null && v !== '';
    if (f.required && !present) {
      formErrors[f.name] = 'Required';
      ok = false;
      continue;
    }
    if (!present) continue;
    if (f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) {
      formErrors[f.name] = 'Invalid email';
      ok = false;
    }
    if (f.type === 'url' && !/^https?:\/\//i.test(String(v))) {
      formErrors[f.name] = 'Must start with http:// or https://';
      ok = false;
    }
    if (
      (f.type === 'number' || f.type === 'integer' || f.type === 'decimal') &&
      Number.isNaN(Number(v))
    ) {
      formErrors[f.name] = 'Must be a number';
      ok = false;
    }
    if (f.type === 'integer' && !Number.isInteger(Number(v))) {
      formErrors[f.name] = 'Must be a whole number';
      ok = false;
    }
  }
  formErrors = { ...formErrors };
  return ok;
}

async function saveRecord() {
  if (!validateForm()) return;
  inserting = true;
  try {
    // Strip empty strings so server uses defaults / NULL where applicable
    // biome-ignore lint/suspicious/noExplicitAny: dynamic payload
    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(insertForm)) {
      if (v === '' || v === undefined) continue;
      payload[k] = v;
    }
    if (drawerMode === 'create') {
      await dataApi.create(collectionName, payload);
      toast.success('Record created');
    } else if (drawerRecordId) {
      await dataApi.update(collectionName, drawerRecordId, payload);
      toast.success('Record updated');
    }
    drawerOpen = false;
    insertForm = {};
    drawerRecordId = null;
    await onSaved();
    // biome-ignore lint/suspicious/noExplicitAny: error shape from api client
  } catch (e: any) {
    toast.error(e.message || 'Failed to save record');
  } finally {
    inserting = false;
  }
}
</script>

<!-- ── Insert Record Drawer (right slide-over) ──────────────────────────── -->
{#if drawerOpen}
  <div
    class="fixed inset-0 z-50 flex"
    role="dialog"
    aria-modal="true"
    aria-label="New Record"
  >
    <!-- Backdrop -->
    <div
      class="flex-1 bg-black/30 backdrop-blur-[1px]"
      role="button"
      tabindex="-1"
      onclick={() => (drawerOpen = false)}
      onkeydown={(e) => e.key === 'Escape' && (drawerOpen = false)}
    ></div>

    <!-- Panel -->
    <div class="w-120 max-w-[95vw] bg-base-100 shadow-2xl flex flex-col h-full border-l border-base-200">

      <!-- Panel header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-base-200 shrink-0">
        <div>
          <h2 class="font-bold text-lg">{drawerMode === 'edit' ? 'Edit Record' : 'New Record'}</h2>
          <p class="text-xs text-base-content/40 font-mono mt-0.5">
            {collectionName}{#if drawerMode === 'edit' && drawerRecordId} · {drawerRecordId.slice(0, 8)}…{/if}
          </p>
        </div>
        <button class="btn btn-ghost btn-sm btn-square" onclick={() => (drawerOpen = false)} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <!-- Panel body (scrollable) -->
      <div class="flex-1 overflow-y-auto px-6 py-5 space-y-5">

        {#if insertableFields.length === 0}
          <div class="flex flex-col items-center justify-center h-full py-16 text-base-content/40 gap-3">
            <Layers size={36} strokeWidth={1.2} />
            <p class="text-sm text-center">
              No fields defined yet.
            </p>
            <button
              class="btn btn-link btn-sm"
              onclick={() => { drawerOpen = false; onGoToSchema(); }}
            >
              Go to Schema to add fields →
            </button>
          </div>
        {:else}

          {#each insertableFields as field (field.name)}
            <div class="space-y-1.5">

              <!-- Field label row -->
              <div class="flex items-center gap-2">
                <label for="ins-{field.name}" class="text-sm font-semibold leading-none">
                  {fieldLabel(field)}
                </label>
                <span class="badge badge-xs badge-outline font-mono opacity-60 {fieldBadgeColor(field.type)}">
                  {field.type}
                </span>
                {#if field.required}
                  <span class="text-error text-xs font-bold ml-auto">required</span>
                {/if}
              </div>

              {#if field.description}
                <p class="text-xs text-base-content/40">{field.description}</p>
              {/if}

              <!-- Input control based on field type -->
              {#if field.type === 'boolean'}
                <label class="flex items-center gap-3 cursor-pointer py-1" for="ins-{field.name}">
                  <input
                    id="ins-{field.name}"
                    type="checkbox"
                    class="toggle toggle-primary toggle-sm"
                    bind:checked={insertForm[field.name]}
                  />
                  <span class="text-sm text-base-content/60">
                    {insertForm[field.name] ? 'Yes' : 'No'}
                  </span>
                </label>

              {:else if field.type === 'textarea' || field.type === 'richtext' || field.type === 'longtext'}
                <textarea
                  id="ins-{field.name}"
                  class="textarea textarea-bordered w-full min-h-28 text-sm resize-y"
                  placeholder="Enter {field.label || field.name}…"
                  bind:value={insertForm[field.name]}
                ></textarea>

              {:else if field.type === 'json' || field.type === 'jsonb'}
                <textarea
                  id="ins-{field.name}"
                  class="textarea textarea-bordered w-full min-h-20 font-mono text-xs resize-y"
                  placeholder={"{}"}
                  bind:value={insertForm[field.name]}
                ></textarea>

              {:else if field.type === 'number' || field.type === 'integer' || field.type === 'decimal'}
                <input
                  id="ins-{field.name}"
                  type="number"
                  class="input input-bordered w-full"
                  placeholder="0"
                  bind:value={insertForm[field.name]}
                />

              {:else if field.type === 'date'}
                <input
                  id="ins-{field.name}"
                  type="date"
                  class="input input-bordered w-full"
                  bind:value={insertForm[field.name]}
                />

              {:else if field.type === 'datetime' || field.type === 'timestamp'}
                <input
                  id="ins-{field.name}"
                  type="datetime-local"
                  class="input input-bordered w-full"
                  bind:value={insertForm[field.name]}
                />

              {:else if field.type === 'select' && (field.options?.choices?.length || field.options?.length)}
                <select
                  id="ins-{field.name}"
                  class="select select-bordered w-full"
                  bind:value={insertForm[field.name]}
                >
                  <option value="">— select —</option>
                  {#each (field.options?.choices ?? field.options ?? []) as opt}
                    <option value={opt.value ?? opt}>{opt.label ?? opt}</option>
                  {/each}
                </select>

              {:else if (field.type === 'm2o' || field.type === 'reference') && field.options?.related_collection}
                <select
                  id="ins-{field.name}"
                  class="select select-bordered w-full"
                  bind:value={insertForm[field.name]}
                >
                  <option value="">
                    {loadingRelOpts ? 'Loading…' : `— select from ${field.options.related_collection} —`}
                  </option>
                  {#if !loadingRelOpts}
                    {#each (relOptions[field.name] ?? []) as opt}
                      <option value={opt.id}>{opt.label}</option>
                    {/each}
                  {/if}
                </select>
                {#if !loadingRelOpts && !(relOptions[field.name]?.length)}
                  <p class="text-xs text-base-content/40 mt-0.5">
                    No records in <span class="font-mono">{field.options.related_collection}</span> yet
                  </p>
                {/if}

              {:else if field.type === 'color'}
                <div class="flex items-center gap-2">
                  <input
                    type="color"
                    class="h-10 w-12 rounded border border-base-300 cursor-pointer p-0.5 bg-transparent"
                    bind:value={insertForm[field.name]}
                  />
                  <input
                    id="ins-{field.name}"
                    type="text"
                    class="input input-bordered flex-1"
                    placeholder="#000000"
                    bind:value={insertForm[field.name]}
                  />
                </div>

              {:else}
                <input
                  id="ins-{field.name}"
                  type="text"
                  class="input input-bordered w-full {formErrors[field.name] ? 'input-error' : ''}"
                  placeholder="Enter {fieldLabel(field)}…"
                  bind:value={insertForm[field.name]}
                />
              {/if}

              {#if formErrors[field.name]}
                <p class="text-error text-xs">{formErrors[field.name]}</p>
              {/if}

            </div>
          {/each}

        {/if}
      </div>

      <!-- Panel footer -->
      <div class="px-6 py-4 border-t border-base-200 flex justify-end gap-2 shrink-0 bg-base-50">
        <button class="btn btn-ghost" onclick={() => (drawerOpen = false)}>Cancel</button>
        <button
          class="btn btn-primary gap-1.5"
          onclick={saveRecord}
          disabled={inserting}
        >
          {#if inserting}
            <span class="loading loading-spinner loading-xs"></span>
          {:else if drawerMode === 'edit'}
            <Save size={14} />
          {:else}
            <Plus size={14} />
          {/if}
          {drawerMode === 'edit' ? 'Update Record' : 'Save Record'}
        </button>
      </div>

    </div>
  </div>
{/if}
