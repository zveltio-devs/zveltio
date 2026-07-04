<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { FileInput, LoaderCircle } from '@lucide/svelte';

const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let forms = $state<any[]>([]);
let loading = $state(true);
let togglingId = $state<string | null>(null);

onMount(loadForms);

async function loadForms() {
  loading = true;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const res = await api.get<{ forms: any[] }>('/ext/forms');
    forms = res.forms ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
async function toggleActive(form: any) {
  togglingId = form.id;
  try {
    await api.patch(`/ext/forms/${form.id}`, { active: !form.active });
    form.active = !form.active;
    forms = [...forms];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(m['forms.error.updatePrefix']() + (e.message ?? ''));
  } finally {
    togglingId = null;
  }
}

async function deleteForm(id: string, name: string) {
  askConfirm(m['ext.confirm.deleteForm']({ name }), () => deleteFormConfirmed(id, name));
}
async function deleteFormConfirmed(id: string, name: string) {
  try {
    await api.delete(`/ext/forms/${id}`);
    forms = forms.filter((f) => f.id !== id);
    toast.success(m['forms.toast.deleted']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(m['ext.errorPrefix']() + (e.message ?? ''));
  }
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function fieldCount(form: any): number {
  try {
    const fields = typeof form.fields === 'string' ? JSON.parse(form.fields) : form.fields;
    return Array.isArray(fields) ? fields.length : 0;
  } catch {
    return 0;
  }
}
</script>

<ExtensionPageShell title={m['forms.title']()} subtitle={m['forms.subtitle']()}>
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
