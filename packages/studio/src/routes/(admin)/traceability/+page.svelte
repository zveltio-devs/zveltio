<script lang="ts">
  const API = '/ext/operations/traceability';

  let lots = $state<any[]>([]);
  let loading = $state(true);
  let error = $state('');
  let search = $state('');
  let statusFilter = $state('');
  let page = $state(1);
  let total = $state(0);
  const limit = 50;

  const totalPages = $derived(Math.ceil(total / limit));

  async function load() {
    loading = true;
    error = '';
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`${API}/lots?${params}`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      lots = json.data;
      total = json.meta.total;
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    load();
  });

  $effect(() => {
    page; statusFilter;
    load();
  });

  function statusClass(status: string): string {
    return {
      available: 'badge-success',
      quarantine: 'badge-warning',
      exhausted: 'badge-neutral',
      recalled: 'badge-error',
      returned: 'badge-info',
    }[status] ?? 'badge-ghost';
  }

  function daysUntilExpiry(date: string): number {
    if (!date) return 999;
    return Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
  }
</script>

<div class="p-6 space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold">Loturi</h1>
    <a href="/admin/trace/reception" class="btn btn-primary btn-sm">
      + Recepție nouă
    </a>
  </div>

  <div class="flex gap-3 flex-wrap">
    <select class="select select-bordered select-sm" bind:value={statusFilter}>
      <option value="">Toate statusurile</option>
      <option value="quarantine">Carantină</option>
      <option value="available">Disponibil</option>
      <option value="exhausted">Epuizat</option>
      <option value="recalled">Retras</option>
    </select>
  </div>

  {#if error}
    <div class="alert alert-error">{error}</div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-12">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-zebra w-full">
        <thead>
          <tr>
            <th>Număr lot</th>
            <th>Produs</th>
            <th>Furnizor</th>
            <th>Status</th>
            <th>Cant. rămasă</th>
            <th>Valabilitate</th>
            <th>Locație</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each lots as lot}
            {@const days = daysUntilExpiry(lot.best_before_date)}
            <tr class={days <= 3 && lot.status === 'available' ? 'bg-error/10' : days <= 7 && lot.status === 'available' ? 'bg-warning/10' : ''}>
              <td class="font-mono text-sm">{lot.lot_number}</td>
              <td>
                <div class="font-medium">{lot.item_name}</div>
                <div class="text-xs text-base-content/50">{lot.item_code}</div>
              </td>
              <td class="text-sm">{lot.supplier_name ?? '—'}</td>
              <td>
                <span class="badge {statusClass(lot.status)} badge-sm">{lot.status}</span>
              </td>
              <td class="text-sm">{lot.quantity_remaining} {lot.unit}</td>
              <td class="text-sm">
                {#if lot.best_before_date}
                  <span class={days <= 3 ? 'text-error font-bold' : days <= 7 ? 'text-warning' : ''}>
                    {lot.best_before_date}
                  </span>
                {:else}
                  —
                {/if}
              </td>
              <td class="text-xs">{[lot.warehouse, lot.row, lot.shelf].filter(Boolean).join(' / ') || '—'}</td>
              <td>
                <a href="/admin/trace/lots/{lot.id}" class="btn btn-ghost btn-xs">Detalii</a>
              </td>
            </tr>
          {/each}
          {#if lots.length === 0}
            <tr><td colspan="8" class="text-center text-base-content/50 py-8">Niciun lot găsit</td></tr>
          {/if}
        </tbody>
      </table>
    </div>

    {#if totalPages > 1}
      <div class="flex justify-center gap-2">
        <button class="btn btn-sm" onclick={() => page--} disabled={page === 1}>‹</button>
        <span class="flex items-center px-3 text-sm">Pagina {page} din {totalPages}</span>
        <button class="btn btn-sm" onclick={() => page++} disabled={page === totalPages}>›</button>
      </div>
    {/if}
  {/if}
</div>
