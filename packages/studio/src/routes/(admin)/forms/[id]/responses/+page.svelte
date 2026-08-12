<script lang="ts">
  /**
   * Submissions for one form.
   *
   * `GET /ext/forms/:id/responses` has been served all along; the manifest
   * pointed `/admin/forms/:id/responses` at a `FormResponsesPage.svelte` that
   * was never written, so every submission the public endpoint accepted landed
   * in a table nobody could open.
   *
   * Answers are rendered against the form's own field list rather than the raw
   * keys: a submission stores field ids, and an id tells a reader nothing.
   */
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { ArrowLeft, LoaderCircle, Inbox } from '@lucide/svelte';

  type Field = { id: string; label: string; type: string };
  type Submission = {
    id: string;
    data: Record<string, unknown>;
    created_at: string;
  };

  const formId = $derived(page.params.id);

  let formName = $state('');
  let fields = $state<Field[]>([]);
  let rows = $state<Submission[]>([]);
  let loading = $state(true);

  onMount(load);

  async function load() {
    loading = true;
    try {
      // One request, not two: `/responses` answers with `{ form, submissions }`,
      // so the field list needed to label the answers arrives with them.
      const res = await api.get<{
        form: { name: string; fields: Field[] | string };
        submissions: Submission[];
      }>(`/ext/forms/${formId}/responses`);
      formName = res.form?.name ?? '';
      const raw = res.form?.fields;
      fields = (typeof raw === 'string' ? JSON.parse(raw) : raw) ?? [];
      rows = res.submissions ?? [];
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
    } finally {
      loading = false;
    }
  }

  /** Label for a stored answer key, falling back to the key when the field is gone. */
  function labelFor(key: string): string {
    return fields.find((f) => f.id === key)?.label || key;
  }

  /**
   * Submissions written before the `::text::jsonb` fix are stored as a jsonb
   * string scalar, and migration 005 converts them — but an instance that has
   * not upgraded yet still serves the old shape. Reading both costs one check
   * and is the difference between a table of answers and a table of single
   * characters.
   */
  function answers(r: Submission): Record<string, unknown> {
    const d = r.data as unknown;
    if (typeof d === 'string') {
      try { return JSON.parse(d); } catch { return {}; }
    }
    return (d as Record<string, unknown>) ?? {};
  }

  function render(v: unknown): string {
    if (v === null || v === undefined || v === '') return '—';
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'boolean') return v ? '✓' : '—';
    return String(v);
  }
</script>

<ExtensionPageShell title={formName || m['forms.title']()} subtitle={m['forms.btn.responses']()}>
  <div class="flex items-center gap-2 mb-4">
    <a href="{base}/forms" class="btn btn-ghost btn-sm gap-1">
      <ArrowLeft size={14}/> {m['forms.btn.back']()}
    </a>
    <a href="{base}/forms/{formId}" class="btn btn-ghost btn-sm">{m['forms.btn.builder']()}</a>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary"/></div>
  {:else if rows.length === 0}
    <div class="card bg-base-200">
      <div class="card-body items-center text-center py-16 gap-3">
        <Inbox size={36} class="text-base-content/20"/>
        <p class="text-sm text-base-content/50">{m['forms.empty.responses']()}</p>
      </div>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead>
          <tr>
            <th>{m['forms.col.submittedAt']()}</th>
            <th>{m['forms.col.answers']()}</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.id)}
            <tr class="hover align-top">
              <td class="text-xs whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
              <td>
                <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  {#each Object.entries(answers(r)) as [k, v]}
                    <dt class="text-base-content/50">{labelFor(k)}</dt>
                    <dd>{render(v)}</dd>
                  {/each}
                </dl>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</ExtensionPageShell>
