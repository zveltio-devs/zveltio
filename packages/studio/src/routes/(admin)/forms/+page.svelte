<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { FileInput, LoaderCircle } from '@lucide/svelte';

  let forms = $state<any[]>([]);
  let loading = $state(true);
  let togglingId = $state<string | null>(null);

  onMount(loadForms);

  async function loadForms() {
    loading = true;
    try {
      const res = await api.get<{ forms: any[] }>('/api/forms');
      forms = res.forms ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load forms'); }
    finally { loading = false; }
  }

  async function toggleActive(form: any) {
    togglingId = form.id;
    try {
      await api.patch(`/api/forms/${form.id}`, { active: !form.active });
      form.active = !form.active;
      forms = [...forms];
    } catch (e: any) { toast.error('Failed to update form: ' + (e.message ?? '')); }
    finally { togglingId = null; }
  }

  async function deleteForm(id: string, name: string) {
    if (!confirm(`Delete form "${name}"? This will also delete all submissions.`)) return;
    try {
      await api.delete(`/api/forms/${id}`);
      forms = forms.filter((f) => f.id !== id);
      toast.success('Form deleted.');
    } catch (e: any) { toast.error('Failed: ' + (e.message ?? '')); }
  }

  function fieldCount(form: any): number {
    try {
      const fields = typeof form.fields === 'string' ? JSON.parse(form.fields) : form.fields;
      return Array.isArray(fields) ? fields.length : 0;
    } catch { return 0; }
  }
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-xl font-semibold flex items-center gap-2"><FileInput size={20} /> Forms</h1>
    <p class="text-sm text-base-content/50">Manage embeddable forms and their submissions</p>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if forms.length === 0}
    <div class="card bg-base-200">
      <div class="card-body items-center py-12 text-base-content/50 text-sm">No forms yet. Use the Forms API to create embeddable forms.</div>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead>
          <tr><th>Name</th><th>Slug</th><th>Fields</th><th>Submissions</th><th>Active</th><th></th></tr>
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
                <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteForm(form.id, form.name)}>Delete</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
