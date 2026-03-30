<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api } from '$lib/api.js';

  let forms = $state<any[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let togglingId = $state<string | null>(null);

  onMount(async () => {
    await loadForms();
  });

  async function loadForms() {
    loading = true;
    try {
      const res = await api.get('/extensions/forms/forms');
      forms = res.forms ?? [];
    } catch (e: any) {
      error = e.message ?? 'Failed to load forms';
    } finally {
      loading = false;
    }
  }

  async function toggleActive(form: any) {
    togglingId = form.id;
    try {
      await api.patch(`/extensions/forms/forms/${form.id}`, { active: !form.active });
      form.active = !form.active;
      forms = [...forms];
    } catch (e: any) {
      alert('Failed to update form: ' + (e.message ?? ''));
    } finally {
      togglingId = null;
    }
  }

  async function deleteForm(id: string, name: string) {
    if (!confirm(`Delete form "${name}"? This will also delete all submissions.`)) return;
    try {
      await api.delete(`/extensions/forms/forms/${id}`);
      forms = forms.filter((f) => f.id !== id);
    } catch (e: any) {
      alert('Failed to delete form: ' + (e.message ?? ''));
    }
  }

  function fieldCount(form: any): number {
    try {
      const fields = typeof form.fields === 'string' ? JSON.parse(form.fields) : form.fields;
      return Array.isArray(fields) ? fields.length : 0;
    } catch {
      return 0;
    }
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between flex-wrap gap-4">
    <div>
      <h1 class="text-2xl font-bold">Forms</h1>
      <p class="text-base-content/60 text-sm mt-0.5">Manage embeddable forms and their submissions</p>
    </div>
    <button class="btn btn-primary btn-sm" onclick={() => goto('/admin/forms/new')}>+ Create Form</button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16">
      <span class="loading loading-spinner loading-lg text-primary"></span>
    </div>
  {:else if error}
    <div class="alert alert-error">
      <span>{error}</span>
    </div>
  {:else if forms.length === 0}
    <div class="flex flex-col items-center justify-center py-20 text-base-content/40 gap-3">
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="opacity-20"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
      <p class="text-lg font-semibold text-base-content/60">No forms yet</p>
      <p class="text-sm text-center max-w-sm">Create embeddable forms to collect data from your users.</p>
      <button class="btn btn-primary btn-sm mt-2" onclick={() => goto('/admin/forms/new')}>Create Form</button>
    </div>
  {:else}
    <div class="card bg-base-100 shadow-sm border border-base-300">
      <div class="overflow-x-auto">
        <table class="table table-zebra">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Fields</th>
              <th>Submissions</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each forms as form}
              <tr
                class="cursor-pointer hover"
                onclick={() => goto(`/admin/forms/${form.id}`)}
              >
                <td class="font-medium">{form.name}</td>
                <td onclick={(e) => e.stopPropagation()}>
                  <code class="badge badge-outline badge-sm font-mono">{form.slug}</code>
                </td>
                <td>{fieldCount(form)}</td>
                <td>{form.submission_count ?? 0}</td>
                <td onclick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    class="toggle toggle-success toggle-sm"
                    checked={form.active}
                    disabled={togglingId === form.id}
                    onchange={() => toggleActive(form)}
                    aria-label={form.active ? 'Deactivate' : 'Activate'}
                  />
                </td>
                <td onclick={(e) => e.stopPropagation()}>
                  <div class="flex gap-1">
                    <button class="btn btn-ghost btn-xs" onclick={() => goto(`/admin/forms/${form.id}/responses`)}>
                      Responses
                    </button>
                    <button class="btn btn-error btn-xs btn-ghost" onclick={() => deleteForm(form.id, form.name)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
