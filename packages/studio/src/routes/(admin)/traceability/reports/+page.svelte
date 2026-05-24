<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import { api } from '$lib/api.js';
  const API = '/ext/operations/traceability';

  type ReportType = 'ansvsa' | 'reception' | 'consumption' | 'stock' | 'haccp';

  let reportType = $state<ReportType>('ansvsa');
  let dateFrom = $state(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  let dateTo = $state(new Date().toISOString().slice(0, 10));
  let loading = $state(false);
  let data = $state<any[]>([]);
  let error = $state('');
  let meta = $state<any>(null);

  const ENDPOINT: Record<ReportType, string> = {
    ansvsa: 'ansvsa-traceability',
    reception: 'reception-log',
    consumption: 'consumption-log',
    stock: 'stock-snapshot',
    haccp: 'haccp-log',
  };

  async function load() {
    loading = true;
    error = '';
    data = [];
    meta = null;
    try {
      const params = new URLSearchParams();
      if (reportType !== 'stock') {
        params.set('from', dateFrom);
        params.set('to', dateTo);
      }
      const res = await api.fetch(`${API}/reports/${ENDPOINT[reportType]}?${params}`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      data = json.data ?? [];
      meta = json.meta ?? null;
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  function downloadCsv() {
    const params = new URLSearchParams({ format: 'csv' });
    if (reportType !== 'stock') {
      params.set('from', dateFrom);
      params.set('to', dateTo);
    }
    window.open(`${API}/reports/${ENDPOINT[reportType]}?${params}`, '_blank');
  }

  const columns = $derived(data.length > 0 ? Object.keys(data[0]) : []);
</script>

<ExtensionPageShell title={m['operations.traceability.reports.title']()}>
  <div class="p-6 space-y-4 pt-0">
  <div class="flex flex-wrap gap-3 items-end">
    <div>
      <label class="label-text text-sm">{m['operations.traceability.reports.report']()}</label>
      <select class="select select-bordered select-sm" bind:value={reportType}>
        <option value="ansvsa">{m['operations.traceability.ui.registru_trasabilitate_ansvsa_ord_111_2008']()}</option>
        <option value="reception">{m['operations.traceability.ui.jurnal_recep_ii']()}</option>
        <option value="consumption">{m['operations.traceability.ui.jurnal_consumuri']()}</option>
        <option value="stock">{m['operations.traceability.ui.stoc_curent_snapshot']()}</option>
        <option value="haccp">{m['operations.traceability.ui.registru_haccp_ccp']()}</option>
      </select>
    </div>

    {#if reportType !== 'stock'}
      <div>
        <label class="label-text text-sm">{m['operations.traceability.reports.from']()}</label>
        <input type="date" class="input input-bordered input-sm" bind:value={dateFrom} />
      </div>
      <div>
        <label class="label-text text-sm">{m['operations.traceability.reports.to']()}</label>
        <input type="date" class="input input-bordered input-sm" bind:value={dateTo} />
      </div>
    {/if}

    <button class="btn btn-primary btn-sm" onclick={load} disabled={loading}>
      {loading ? 'Se încarcă...' : 'Generează'}
    </button>

    {#if data.length > 0}
      <button class="btn btn-outline btn-sm" onclick={downloadCsv}>
        {m['operations.traceability.ui.descarc_csv']()}
      </button>
    {/if}
  </div>

  {#if error}
    <div class="alert alert-error">{error}</div>
  {/if}

  {#if meta}
    <div class="text-sm opacity-60">
      {meta.count ?? data.length} înregistrări
      {#if meta.from} | Perioadă: {meta.from} — {meta.to}{/if}
      {#if meta.generated_at} | Generat la: {new Date(meta.generated_at).toLocaleString('ro-RO')}{/if}
    </div>
  {/if}

  {#if data.length > 0}
    <div class="overflow-x-auto" style="max-height: 60vh;">
      <table class="table table-xs table-zebra w-full">
        <thead>
          <tr>
            {#each columns as col}
              <th class="whitespace-nowrap">{col}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each data as row}
            <tr>
              {#each columns as col}
                <td class="whitespace-nowrap max-w-xs overflow-hidden text-ellipsis">
                  {#if typeof row[col] === 'object' && row[col] !== null}
                    <span title={JSON.stringify(row[col])} class="font-mono text-xs opacity-70">[{Array.isArray(row[col]) ? row[col].length + ' items' : 'obj'}]</span>
                  {:else}
                    {row[col] ?? '—'}
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if !loading}
    <div class="text-center opacity-50 py-12">
      Selectați parametrii și apăsați "Generează" pentru a vedea raportul.
    </div>
  {/if}
  </div>
</ExtensionPageShell>
