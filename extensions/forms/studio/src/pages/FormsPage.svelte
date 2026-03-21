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

<div class="forms-page">
  <div class="page-header">
    <h1>Forms</h1>
    <button class="btn-primary" onclick={() => goto('/admin/forms/new')}>+ Create Form</button>
  </div>

  {#if loading}
    <p class="loading">Loading forms…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if forms.length === 0}
    <div class="empty-state">
      <p>No forms yet.</p>
      <button class="btn-primary" onclick={() => goto('/admin/forms/new')}>Create your first form</button>
    </div>
  {:else}
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Slug</th>
            <th>Fields</th>
            <th>Submissions</th>
            <th>Active</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each forms as form}
            <tr
              class="clickable-row"
              onclick={() => goto(`/admin/forms/${form.id}`)}
            >
              <td class="form-name">{form.name}</td>
              <td class="slug"><code>{form.slug}</code></td>
              <td>{fieldCount(form)}</td>
              <td>{form.submission_count ?? 0}</td>
              <td onclick={(e) => e.stopPropagation()}>
                <button
                  class="toggle"
                  class:active={form.active}
                  disabled={togglingId === form.id}
                  onclick={() => toggleActive(form)}
                  aria-label={form.active ? 'Deactivate' : 'Activate'}
                >
                  <span class="toggle-knob"></span>
                </button>
              </td>
              <td onclick={(e) => e.stopPropagation()}>
                <button class="btn-sm" onclick={() => goto(`/admin/forms/${form.id}/responses`)}>
                  Responses
                </button>
                <button class="btn-sm btn-danger" onclick={() => deleteForm(form.id, form.name)}>
                  Delete
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .forms-page { max-width: 1100px; margin: 0 auto; padding: 2rem; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
  h1 { font-size: 1.75rem; font-weight: 700; }
  .loading { color: #6b7280; }
  .error { color: #ef4444; }
  .empty-state { text-align: center; padding: 3rem; color: #6b7280; }
  .empty-state p { margin-bottom: 1rem; }
  .table-wrapper { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th { text-align: left; padding: 0.65rem 0.75rem; background: #f9fafb; border-bottom: 2px solid #e5e7eb; font-weight: 600; color: #374151; }
  td { padding: 0.65rem 0.75rem; border-bottom: 1px solid #f3f4f6; }
  .clickable-row { cursor: pointer; }
  .clickable-row:hover td { background: #f9fafb; }
  .form-name { font-weight: 500; }
  .slug code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }
  .toggle {
    width: 40px; height: 22px; background: #d1d5db; border: none; border-radius: 11px;
    position: relative; cursor: pointer; padding: 0; transition: background 0.2s;
  }
  .toggle.active { background: #22c55e; }
  .toggle-knob {
    position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
    background: white; border-radius: 50%; transition: left 0.2s;
  }
  .toggle.active .toggle-knob { left: 21px; }
  .btn-primary {
    padding: 0.5rem 1rem; background: #6366f1; color: white; border: none;
    border-radius: 6px; cursor: pointer; font-weight: 500;
  }
  .btn-primary:hover { background: #4f46e5; }
  .btn-sm {
    padding: 0.25rem 0.6rem; border: 1px solid #e5e7eb; background: white;
    border-radius: 4px; cursor: pointer; font-size: 0.8rem; margin-right: 0.25rem;
  }
  .btn-sm:hover { background: #f9fafb; }
  .btn-danger { border-color: #fca5a5; color: #dc2626; }
  .btn-danger:hover { background: #fef2f2; }
</style>
