<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
// Create/Edit record slide-over. Extracted from collections/[name]/+page.svelte
// (H-07 studio split). Self-contained form: the parent passes the collection
// name + the insertable field list and an `onSaved` callback; this component
// owns the drawer open/mode state and exposes `openCreate()` / `openEdit()` so
// the page header + data-table rows can trigger it via `bind:this`.
import { X, Layers, Save, Plus, History, ChevronDown } from '@lucide/svelte';
import { api, dataApi } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { fieldLabel, fieldBadgeColor, labelFromRecord } from './field-helpers.js';
import type { CollectionField, CollectionRecord } from './types.js';

interface Props {
  collectionName: string;
  insertableFields: CollectionField[];
  /** Called after a successful create/update so the parent can reload rows. */
  onSaved: () => void | Promise<void>;
  /** Called from the "no fields → go to Schema" link. */
  onGoToSchema: () => void;
}
const { collectionName, insertableFields, onSaved, onGoToSchema }: Props = $props();

// ── Who changed this, and when ───────────────────────────
//
// There is a global audit page, and the question a person actually asks standing
// in front of a record is narrower: "who changed THIS". Answering it meant
// leaving the record, opening another screen and filtering it down — so in
// practice nobody asked.
//
// `zv_revisions` was built for exactly this query and the Studio never ran it
// here: the table carries an index on `(collection, record_id, created_at DESC)`
// and nothing else uses it that way.
type Revision = {
  id: string;
  action: 'create' | 'update' | 'delete';
  delta: Record<string, unknown> | null;
  user_email: string | null;
  user_id: string | null;
  created_at: string;
};

let history = $state<Revision[]>([]);
let historyLoading = $state(false);
let historyOpen = $state(false);
let historyError = $state<string | null>(null);

async function loadHistory() {
  if (!drawerRecordId) return;
  historyLoading = true;
  historyError = null;
  try {
    const res = await api.get<{ revisions: Revision[] }>(
      `/api/admin/revisions?collection=${encodeURIComponent(collectionName)}` +
        `&record_id=${encodeURIComponent(drawerRecordId)}&limit=20`,
    );
    history = res.revisions ?? [];
  } catch (e) {
    // NOT swallowed into an empty list. "Could not load the history" and "this
    // record has no history" are different sentences, and showing the second
    // when the first is true is the same lie this codebase has spent the day
    // removing — the first version of this function did exactly that, and hid a
    // missing import behind "No changes recorded yet".
    historyError = (e as Error).message || m['common.failed']();
    history = [];
  } finally {
    historyLoading = false;
  }
}

/** The field names a revision touched, which is the part worth reading. */
function changedFields(r: Revision): string[] {
  if (!r.delta || typeof r.delta !== 'object') return [];
  return Object.keys(r.delta);
}

let drawerOpen = $state(false);
let drawerMode = $state<'create' | 'edit'>('create');
let drawerRecordId = $state<string | null>(null);
// biome-ignore lint/suspicious/noExplicitAny: form values bind to <input> (string|number|boolean|Date) — `unknown` breaks bind:value
let insertForm = $state<Record<string, any>>({});
let inserting = $state(false);
let relOptions = $state<Record<string, { id: string; label: string }[]>>({});
let loadingRelOpts = $state(false);
let formErrors = $state<Record<string, string>>({});

// A select field's `options` is a legacy-polymorphic display shape —
// `{ choices: [...] }`, or an array of bare strings, or an array of
// `{ value, label }`. Typing it fully isn't worth it for rendering a dropdown;
// the values are coerced to strings by the <option>.
// biome-ignore lint/suspicious/noExplicitAny: legacy-polymorphic options shape (see above)
function selectChoices(field: CollectionField): any[] {
  // biome-ignore lint/suspicious/noExplicitAny: legacy-polymorphic options shape
  const o = field.options as any;
  return o?.choices ?? o ?? [];
}

async function loadRelOptions() {
  loadingRelOpts = true;
  const relFields = insertableFields.filter(
    (f) => (f.type === 'm2o' || f.type === 'reference') && f.options?.related_collection,
  );
  const entries = await Promise.all(
    relFields.map(async (f) => {
      try {
        const res = await dataApi.list(f.options!.related_collection as string, { limit: '200' });
        return [
          f.name,
          (res.records ?? []).map((r: CollectionRecord) => ({
            id: r.id,
            label: labelFromRecord(r),
          })),
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

export function openEdit(record: CollectionRecord) {
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
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(insertForm)) {
      if (v === '' || v === undefined) continue;
      payload[k] = v;
    }
    if (drawerMode === 'create') {
      await dataApi.create(collectionName, payload);
      toast.success(m['record.created']());
    } else if (drawerRecordId) {
      await dataApi.update(collectionName, drawerRecordId, payload);
      toast.success(m['record.updated']());
    }
    drawerOpen = false;
    insertForm = {};
    drawerRecordId = null;
    await onSaved();
  } catch (e) {
    toast.error((e as Error).message || 'Failed to save record');
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
    aria-label={m['record.new']()}
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
          <p class="text-xs text-base-content/65 font-mono mt-0.5">
            {collectionName}{#if drawerMode === 'edit' && drawerRecordId} · {drawerRecordId.slice(0, 8)}…{/if}
          </p>
        </div>
        <button class="btn btn-ghost btn-sm btn-square" onclick={() => (drawerOpen = false)} aria-label={m['common.close']()}>
          <X size={16} />
        </button>
      </div>

      <!-- Panel body (scrollable) -->
      <div class="flex-1 overflow-y-auto px-6 py-5 space-y-5">

        {#if insertableFields.length === 0}
          <div class="flex flex-col items-center justify-center h-full py-16 text-base-content/65 gap-3">
            <Layers size={36} strokeWidth={1.2} />
            <p class="text-sm text-center">
              {m['fields.noneDefined']()}
            </p>
            <button
              class="btn btn-link btn-sm"
              onclick={() => { drawerOpen = false; onGoToSchema(); }}
            >
              {m['fields.goToSchema']()}
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
                <p class="text-xs text-base-content/65">{field.description}</p>
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
                  <span class="text-sm text-base-content/65">
                    {insertForm[field.name] ? 'Yes' : 'No'}
                  </span>
                </label>

              {:else if field.type === 'textarea' || field.type === 'richtext' || field.type === 'longtext'}
                <textarea
                  id="ins-{field.name}"
                  class="textarea textarea-bordered w-full min-h-28 text-sm resize-y"
                  placeholder={m['record.enterField']({ field: field.label || field.name })}
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

              {:else if field.type === 'select' && selectChoices(field).length}
                <select
                  id="ins-{field.name}"
                  class="select select-bordered w-full"
                  bind:value={insertForm[field.name]}
                >
                  <option value="">{m['common.selectPlaceholder']()}</option>
                  {#each selectChoices(field) as opt}
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
                  <p class="text-xs text-base-content/65 mt-0.5">
                    {m['relations.noRecordsIn']({ name: field.options.related_collection })}
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
                  placeholder={m['record.enterField']({ field: fieldLabel(field) })}
                  bind:value={insertForm[field.name]}
                />
              {/if}

              {#if formErrors[field.name]}
                <p class="text-error text-xs">{formErrors[field.name]}</p>
              {/if}

            </div>
          {/each}

        {/if}

        {#if drawerMode === 'edit' && drawerRecordId}
          <!-- Collapsed by default and loaded only when opened: the history is a
               question people ask sometimes, and the fields are what they came
               for. A drawer that is merely being edited should not pay for a
               query nobody asked for. -->
          <div class="border-t border-base-200 pt-4">
            <button
              type="button"
              class="flex w-full items-center justify-between text-sm font-medium text-base-content/70 hover:text-base-content"
              onclick={() => {
                historyOpen = !historyOpen;
                if (historyOpen && history.length === 0) void loadHistory();
              }}
            >
              <span class="flex items-center gap-2"><History size={14} /> {m['record.history']()}</span>
              <ChevronDown size={14} class="transition-transform {historyOpen ? 'rotate-180' : ''}" />
            </button>

            {#if historyOpen}
              <div class="mt-3">
                {#if historyLoading}
                  <p class="text-xs text-base-content/65">{m['common.loading']()}</p>
                {:else if historyError}
                  <p class="text-xs text-error">{historyError}</p>
                {:else if history.length === 0}
                  <p class="text-xs text-base-content/65">{m['record.noHistory']()}</p>
                {:else}
                  <ol class="flex flex-col gap-3">
                    {#each history as rev (rev.id)}
                      <li class="flex gap-3 text-xs">
                        <span
                          class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full {rev.action === 'create'
                            ? 'bg-success'
                            : rev.action === 'delete'
                              ? 'bg-error'
                              : 'bg-primary'}"
                        ></span>
                        <div class="min-w-0">
                          <p class="text-base-content/80">
                            {rev.action === 'create'
                              ? m['record.created']()
                              : rev.action === 'delete'
                                ? m['record.deletedAction']()
                                : m['record.updated']()}
                            {#if changedFields(rev).length > 0}
                              <span class="text-base-content/65">· {changedFields(rev).join(', ')}</span>
                            {/if}
                          </p>
                          <p class="text-base-content/65">
                            {rev.user_email ?? m['dashboard.actorSystem']()} ·
                            {new Date(rev.created_at).toLocaleString()}
                          </p>
                        </div>
                      </li>
                    {/each}
                  </ol>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

      </div>

      <!-- Panel footer -->
      <div class="px-6 py-4 border-t border-base-200 flex justify-end gap-2 shrink-0 bg-base-50">
        <button class="btn btn-ghost" onclick={() => (drawerOpen = false)}>{m['common.cancel']()}</button>
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
