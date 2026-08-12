<script lang="ts">
  /**
   * Form builder.
   *
   * The manifest has always declared `/admin/forms/:id` pointing at a
   * `FormBuilderPage.svelte` that does not exist, so the promise was in the
   * catalogue and nowhere else: the list page could open a form for editing and
   * there was nothing to open.
   *
   * The engine has served the whole contract the entire time —
   * `GET /ext/forms/:id`, `PATCH /ext/forms/:id` with the same `fields` array
   * the public submit endpoint validates against. This is that contract, drawn.
   */
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { ArrowLeft, Plus, Trash2, Save, LoaderCircle, Inbox } from '@lucide/svelte';

  /** Mirrors `fieldSchema` in the extension's routes.ts — keep the two in step. */
  const FIELD_TYPES = [
    'text', 'textarea', 'email', 'number',
    'select', 'multiselect', 'checkbox', 'date', 'file',
  ] as const;

  type Field = {
    id: string;
    type: (typeof FIELD_TYPES)[number];
    label: string;
    required: boolean;
    placeholder?: string;
    options?: string[];
  };
  type Form = {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    fields: Field[];
    target_collection: string | null;
    active: boolean;
  };

  const formId = $derived(page.params.id);

  let form = $state<Form | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let notFound = $state(false);

  onMount(load);

  async function load() {
    loading = true;
    try {
      const res = await api.get<{ form: Form }>(`/ext/forms/${formId}`);
      const f = res.form;
      form = {
        ...f,
        // `fields` is a jsonb column; some rows come back as a JSON string.
        fields: (typeof f.fields === 'string' ? JSON.parse(f.fields as unknown as string) : f.fields) ?? [],
      };
    } catch (e: unknown) {
      notFound = true;
      toast.error(e instanceof Error ? e.message : m['forms.error.notFound']());
    } finally {
      loading = false;
    }
  }

  function addField() {
    if (!form) return;
    form.fields = [
      ...form.fields,
      { id: crypto.randomUUID(), type: 'text', label: '', required: false },
    ];
  }

  function removeField(idx: number) {
    if (!form) return;
    form.fields = form.fields.filter((_, i) => i !== idx);
  }

  function optionsText(f: Field): string {
    return (f.options ?? []).join(', ');
  }

  function setOptions(idx: number, value: string) {
    if (!form) return;
    const opts = value.split(',').map((s) => s.trim()).filter(Boolean);
    form.fields = form.fields.map((f, i) => (i === idx ? { ...f, options: opts } : f));
  }

  /** `select` and `multiselect` are the only types the engine reads options for. */
  function takesOptions(type: string): boolean {
    return type === 'select' || type === 'multiselect';
  }

  async function save() {
    if (!form) return;
    saving = true;
    try {
      await api.patch(`/ext/forms/${form.id}`, {
        name: form.name,
        slug: form.slug,
        description: form.description ?? undefined,
        target_collection: form.target_collection ?? undefined,
        active: form.active,
        // Options only travel for the types that use them; the engine stores
        // whatever it is given, and a stray list on a text field is noise that
        // outlives the edit that produced it.
        fields: form.fields.map((f) => ({
          id: f.id,
          type: f.type,
          label: f.label,
          required: f.required,
          ...(f.placeholder ? { placeholder: f.placeholder } : {}),
          ...(takesOptions(f.type) && f.options?.length ? { options: f.options } : {}),
        })),
      });
      toast.success(m['forms.toast.saved']());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.errorPrefix']());
    } finally {
      saving = false;
    }
  }
</script>

<ExtensionPageShell title={form?.name ?? m['forms.title']()} subtitle={form?.slug}>
  <div class="flex items-center gap-2 mb-4">
    <a href="{base}/forms" class="btn btn-ghost btn-sm gap-1">
      <ArrowLeft size={14}/> {m['forms.btn.back']()}
    </a>
    {#if form}
      <a href="{base}/forms/{form.id}/responses" class="btn btn-ghost btn-sm gap-1">
        <Inbox size={14}/> {m['forms.btn.responses']()}
      </a>
      <div class="flex-1"></div>
      <button class="btn btn-primary btn-sm gap-1" onclick={save} disabled={saving}>
        {#if saving}<LoaderCircle size={14} class="animate-spin"/>{:else}<Save size={14}/>{/if}
        {m['forms.btn.save']()}
      </button>
    {/if}
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary"/></div>
  {:else if notFound || !form}
    <div class="card bg-base-200">
      <div class="card-body items-center text-center py-16">
        <p class="text-sm text-base-content/50">{m['forms.error.notFound']()}</p>
      </div>
    </div>
  {:else}
    <div class="card bg-base-200 mb-4">
      <div class="card-body gap-3">
        <p class="text-xs font-medium text-base-content/70">{m['forms.section.details']()}</p>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label class="form-control">
            <span class="label-text text-xs">{m['forms.form.name']()}</span>
            <input class="input input-sm input-bordered" bind:value={form.name}/>
          </label>
          <label class="form-control">
            <span class="label-text text-xs">{m['forms.form.slug']()}</span>
            <input class="input input-sm input-bordered" bind:value={form.slug}/>
          </label>
          <label class="form-control md:col-span-2">
            <span class="label-text text-xs">{m['forms.form.description']()}</span>
            <input class="input input-sm input-bordered" bind:value={form.description}/>
          </label>
          <label class="form-control">
            <span class="label-text text-xs">{m['forms.form.targetCollection']()}</span>
            <input class="input input-sm input-bordered" bind:value={form.target_collection}/>
          </label>
          <label class="flex items-center gap-2 mt-6">
            <input type="checkbox" class="toggle toggle-sm toggle-primary" bind:checked={form.active}/>
            <span class="text-xs">{m['forms.form.active']()}</span>
          </label>
        </div>
      </div>
    </div>

    <div class="card bg-base-200">
      <div class="card-body gap-3">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-base-content/70">{m['forms.section.fields']()}</p>
          <button class="btn btn-ghost btn-xs gap-1" onclick={addField}>
            <Plus size={12}/> {m['forms.btn.addField']()}
          </button>
        </div>

        {#each form.fields as field, idx (idx)}
          <div class="bg-base-100 rounded-lg p-3 grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
            <label class="form-control md:col-span-4">
              <span class="label-text text-xs">{m['forms.field.label']()}</span>
              <input class="input input-xs input-bordered" bind:value={field.label}/>
            </label>
            <label class="form-control md:col-span-3">
              <span class="label-text text-xs">{m['forms.field.type']()}</span>
              <select class="select select-xs select-bordered" bind:value={field.type}>
                {#each FIELD_TYPES as t}<option value={t}>{t}</option>{/each}
              </select>
            </label>
            <label class="form-control md:col-span-3">
              <span class="label-text text-xs">{m['forms.field.placeholder']()}</span>
              <input class="input input-xs input-bordered" bind:value={field.placeholder}/>
            </label>
            <label class="flex items-center gap-1 md:col-span-1 pb-1">
              <input type="checkbox" class="checkbox checkbox-xs" bind:checked={field.required}/>
              <span class="text-xs">{m['forms.field.required']()}</span>
            </label>
            <button class="btn btn-ghost btn-xs text-error md:col-span-1" onclick={() => removeField(idx)}>
              <Trash2 size={12}/>
            </button>

            {#if takesOptions(field.type)}
              <label class="form-control md:col-span-12">
                <span class="label-text text-xs">{m['forms.field.options']()}</span>
                <input
                  class="input input-xs input-bordered"
                  value={optionsText(field)}
                  oninput={(e) => setOptions(idx, (e.currentTarget as HTMLInputElement).value)}
                />
              </label>
            {/if}
          </div>
        {:else}
          <p class="text-xs text-base-content/40 py-4 text-center">{m['forms.empty.fields']()}</p>
        {/each}
      </div>
    </div>
  {/if}
</ExtensionPageShell>
