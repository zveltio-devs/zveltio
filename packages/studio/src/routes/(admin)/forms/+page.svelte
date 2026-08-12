<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
        import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { FileInput, LoaderCircle, Plus, Pencil, Inbox } from '@lucide/svelte';
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';

  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  let forms = $state<any[]>([]);
  let loading = $state(true);
  let togglingId = $state<string | null>(null);

  let creating = $state(false);

  onMount(loadForms);

  /**
   * The manifest promised a builder at `/admin/forms/:id` and there was no way
   * to reach one — no create button, no link from a row. A form could be listed,
   * toggled and deleted, and never edited.
   *
   * A new form is created with a placeholder name and an empty field list, then
   * opened in the builder: `slug` is required by the engine and must be unique,
   * so it is derived from the timestamp rather than asked for up front.
   */
  async function createForm() {
    creating = true;
    try {
      const stamp = Date.now().toString(36);
      const res = await api.post<{ form: { id: string } }>('/ext/forms', {
        name: m['forms.btn.new'](),
        slug: `form-${stamp}`,
        fields: [],
        active: false,
      });
      toast.success(m['forms.toast.created']());
      goto(`${base}/forms/${res.form.id}`);
    } catch (e: any) {
      toast.error(e instanceof Error ? e.message : m['ext.errorPrefix']());
    } finally {
      creating = false;
    }
  }

  async function loadForms() {
    loading = true;
    try {
      const res = await api.get<{ forms: any[] }>('/ext/forms');
      forms = res.forms ?? [];
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
    finally { loading = false; }
  }

  async function toggleActive(form: any) {
    togglingId = form.id;
    try {
      await api.patch(`/ext/forms/${form.id}`, { active: !form.active });
      form.active = !form.active;
      forms = [...forms];
    } catch (e: any) { toast.error(m['forms.error.updatePrefix']() + (e.message ?? '')); }
    finally { togglingId = null; }
  }

  async function deleteForm(id: string, name: string) {
        askConfirm(m['ext.confirm.deleteForm']({ name }), () => deleteFormConfirmed(id, name));
  }
  async function deleteFormConfirmed(id: string, name: string) {
    try {
      await api.delete(`/ext/forms/${id}`);
      forms = forms.filter((f) => f.id !== id);
      toast.success(m['forms.toast.deleted']());
    } catch (e: any) { toast.error(m['ext.errorPrefix']() + (e.message ?? '')); }
  }


  function fieldCount(form: any): number {
    try {
      const fields = typeof form.fields === 'string' ? JSON.parse(form.fields) : form.fields;
      return Array.isArray(fields) ? fields.length : 0;
    } catch { return 0; }
  }
</script>

<ExtensionPageShell title={m['forms.title']()} subtitle={m['forms.subtitle']()}>
  <div class="flex justify-end mb-4">
    <button class="btn btn-primary btn-sm gap-1" onclick={createForm} disabled={creating}>
      {#if creating}<LoaderCircle size={14} class="animate-spin"/>{:else}<Plus size={14}/>{/if}
      {m['forms.btn.new']()}
    </button>
  </div>
{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if forms.length === 0}
    <div class="card bg-base-200">
      <div class="card-body items-center py-12 text-base-content/50 text-sm">{m['forms.empty']()}</div>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead>
          <tr><th>{m['common.col.name']()}</th><th>{m['common.col.slug']()}</th><th>{m['forms.col.fields']()}</th><th>{m['forms.col.submissions']()}</th><th>{m['common.col.active']()}</th><th></th></tr>
        </thead>
        <tbody>
          {#each forms as form (form.id)}
            <tr class="hover">
              <td class="font-medium text-sm">{form.name}</td>
              <td><code class="badge badge-outline badge-sm font-mono">{form.slug}</code></td>
              <td class="text-sm">{fieldCount(form)}</td>
              <td class="text-sm">{form.submission_count ?? 0}</td>
              <td>
                <input
                  type="checkbox"
                  class="toggle toggle-success toggle-sm"
                  checked={form.active}
                  disabled={togglingId === form.id}
                  onchange={() => toggleActive(form)}
                  aria-label={form.active ? 'Deactivate' : 'Activate'}
                />
              </td>
              <td>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteForm(form.id, form.name)}>{m['common.delete']()}</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel}
  confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction}
  oncancel={cancelConfirm}
/>

</ExtensionPageShell>
