<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api } from '$lib/api.js';

  let form = $state<any>(null);
  let submissions = $state<any[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let deleting = $state<string | null>(null);

  let formFields = $derived<any[]>(
    form ? (typeof form.fields === 'string' ? JSON.parse(form.fields) : form.fields ?? []) : [],
  );

  onMount(async () => {
    const id = $page.params.id;
    try {
      const res = await api.get(`/extensions/forms/forms/${id}/responses`);
      form = res.form;
      submissions = res.submissions ?? [];
    } catch (e: any) {
      error = e.message ?? 'Failed to load responses';
    } finally {
      loading = false;
    }
  });

  async function deleteSubmission(id: string) {
    if (!confirm('Delete this submission?')) return;
    deleting = id;
    try {
      await api.delete(`/extensions/forms/submissions/${id}`);
      submissions = submissions.filter((s) => s.id !== id);
    } catch (e: any) {
      alert('Failed to delete: ' + (e.message ?? ''));
    } finally {
      deleting = null;
    }
  }

  function exportCSV() {
    if (!formFields.length || !submissions.length) return;
    const headers = ['id', 'created_at', ...formFields.map((f: any) => f.label ?? f.id)];
    const rows = submissions.map((s) => {
      const data = typeof s.data === 'string' ? JSON.parse(s.data) : s.data;
      return [
        s.id,
        s.created_at,
        ...formFields.map((f: any) => {
          const val = data[f.id] ?? '';
          // Escape CSV value
          const str = String(val);
          return str.includes(',') || str.includes('"') || str.includes('\n')
            ? `"${str.replace(/"/g, '""')}"`
            : str;
        }),
      ].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${form?.slug ?? 'responses'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function getCellValue(submission: any, fieldId: string): string {
    const data = typeof submission.data === 'string' ? JSON.parse(submission.data) : submission.data;
    const val = data[fieldId];
    if (val === undefined || val === null) return '—';
    if (Array.isArray(val)) return val.join(', ');
    return String(val);
  }
</script>

<div class="responses-page">
  <div class="page-header">
    <button class="btn-back" onclick={() => goto('/admin/forms')}>← Back to Forms</button>
    {#if form}
      <h1>Responses: {form.name}</h1>
    {:else}
      <h1>Responses</h1>
    {/if}
    <button class="btn-export" onclick={exportCSV} disabled={!submissions.length}>
      Export CSV
    </button>
  </div>

  {#if loading}
    <p class="loading">Loading responses…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if submissions.length === 0}
    <div class="empty-state">
      <p>No submissions yet.</p>
    </div>
  {:else}
    <p class="count">{submissions.length} submission{submissions.length !== 1 ? 's' : ''}</p>
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Submitted At</th>
            {#each formFields as field}
              <th>{field.label ?? field.id}</th>
            {/each}
            <th>IP</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each submissions as sub}
            <tr>
              <td class="time">{new Date(sub.created_at).toLocaleString()}</td>
              {#each formFields as field}
                <td class="cell-value">{getCellValue(sub, field.id)}</td>
              {/each}
              <td class="ip">{sub.ip_address ?? '—'}</td>
              <td>
                <button
                  class="btn-delete"
                  onclick={() => deleteSubmission(sub.id)}
                  disabled={deleting === sub.id}
                >
                  {deleting === sub.id ? '…' : 'Delete'}
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
  .responses-page { max-width: 1200px; margin: 0 auto; padding: 2rem; }
  .page-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.5rem; font-weight: 700; flex: 1; }
  .btn-back { background: none; border: none; cursor: pointer; color: #6366f1; font-size: 0.9rem; }
  .btn-export {
    padding: 0.4rem 0.9rem; background: white; border: 1px solid #e5e7eb;
    border-radius: 6px; cursor: pointer; font-size: 0.875rem;
  }
  .btn-export:hover:not(:disabled) { background: #f9fafb; }
  .btn-export:disabled { opacity: 0.5; cursor: not-allowed; }
  .loading { color: #6b7280; }
  .error { color: #ef4444; }
  .empty-state { text-align: center; padding: 3rem; color: #6b7280; }
  .count { font-size: 0.875rem; color: #6b7280; margin-bottom: 0.75rem; }
  .table-wrapper { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th { text-align: left; padding: 0.6rem 0.75rem; background: #f9fafb; border-bottom: 2px solid #e5e7eb; font-weight: 600; color: #374151; white-space: nowrap; }
  td { padding: 0.6rem 0.75rem; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  .time, .ip { color: #9ca3af; font-size: 0.8rem; white-space: nowrap; }
  .cell-value { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn-delete {
    padding: 0.2rem 0.5rem; background: white; border: 1px solid #fca5a5;
    color: #dc2626; border-radius: 4px; cursor: pointer; font-size: 0.8rem;
  }
  .btn-delete:hover:not(:disabled) { background: #fef2f2; }
</style>
