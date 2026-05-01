<script lang="ts">
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { auth } from '$lib/auth.svelte.js';
  import { FileX, ShieldCheck, ArrowLeft } from '@lucide/svelte';

  const ZONE_SLUG = 'intranet';

  let pageData = $state<{ page: any; zone: any; views: any[] } | null>(null);
  let loading = $state(true);
  let error = $state<{ status: number; message: string } | null>(null);

  const slug = $derived(page.params.slug);

  // Re-fetch whenever the slug changes (navigation between zone pages)
  $effect(() => {
    const s = slug;
    loading = true;
    error = null;
    pageData = null;

    // Use a manual fetch so we can read the HTTP status (api wrapper throws on
    // non-ok and loses the status code). 404 vs 403 vs 500 each get distinct UX.
    fetch(`/api/zones/${ZONE_SLUG}/render/${encodeURIComponent(s ?? '')}`, { credentials: 'include' })
      .then(async (res) => {
        if (res.ok) {
          pageData = await res.json();
          return;
        }
        const body = await res.json().catch(() => ({}));
        error = {
          status: res.status,
          message: body?.error ?? body?.message ?? `HTTP ${res.status}`,
        };
      })
      .catch((e) => {
        error = { status: 0, message: e?.message ?? 'Network error' };
      })
      .finally(() => { loading = false; });
  });

  const isAdmin = $derived(auth.user?.role === 'admin' || auth.user?.role === 'owner');
</script>

{#if loading}
  <div class="flex items-center justify-center py-20">
    <span class="loading loading-spinner loading-md text-primary"></span>
  </div>

{:else if error}
  <div class="max-w-md mx-auto mt-12 text-center">
    {#if error.status === 404}
      <FileX size={48} class="mx-auto text-base-content/30" strokeWidth={1.2} />
      <h1 class="text-lg font-semibold mt-4">Page not found</h1>
      <p class="text-sm text-base-content/55 mt-1.5">
        There's no page with the slug <code class="font-mono px-1.5 py-0.5 rounded bg-base-200">{slug}</code> in the Intranet zone.
      </p>
      <div class="flex gap-2 justify-center mt-5">
        <a href="{base}/intranet" class="btn btn-ghost btn-sm gap-1.5">
          <ArrowLeft size={14} /> Back to Intranet
        </a>
        {#if isAdmin}
          <a href="{base}/zones/intranet" class="btn btn-primary btn-sm gap-1.5">
            <ShieldCheck size={14} /> Configure in Admin
          </a>
        {/if}
      </div>
    {:else if error.status === 403}
      <ShieldCheck size={48} class="mx-auto text-warning" strokeWidth={1.2} />
      <h1 class="text-lg font-semibold mt-4">Access denied</h1>
      <p class="text-sm text-base-content/55 mt-1.5">
        You don't have permission to view this page. Ask an administrator if this is unexpected.
      </p>
      <a href="{base}/intranet" class="btn btn-ghost btn-sm gap-1.5 mt-5">
        <ArrowLeft size={14} /> Back to Intranet
      </a>
    {:else}
      <FileX size={48} class="mx-auto text-error" strokeWidth={1.2} />
      <h1 class="text-lg font-semibold mt-4">Something went wrong</h1>
      <p class="text-sm text-base-content/55 mt-1.5">{error.message}</p>
      <a href="{base}/intranet" class="btn btn-ghost btn-sm gap-1.5 mt-5">
        <ArrowLeft size={14} /> Back to Intranet
      </a>
    {/if}
  </div>

{:else if pageData}
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold text-base-content">{pageData.page.title}</h1>
      {#if pageData.page.description}
        <p class="text-sm text-base-content/60 mt-1">{pageData.page.description}</p>
      {/if}
    </div>

    {#each pageData.views as view}
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-4">
          {#if view.definition.name}
            <h2 class="text-sm font-semibold text-base-content/70 mb-3">
              {view.title_override ?? view.definition.name}
            </h2>
          {/if}

          {#if view.definition.view_type === 'table'}
            {#if view.data?.records?.length}
              <div class="overflow-x-auto">
                <table class="table table-sm w-full">
                  <thead>
                    <tr>
                      {#each (view.definition.fields ?? []) as field}
                        <th class="text-xs">{field.label ?? field.key}</th>
                      {/each}
                    </tr>
                  </thead>
                  <tbody>
                    {#each view.data.records as record}
                      <tr class="hover">
                        {#each (view.definition.fields ?? []) as field}
                          <td class="text-sm">{record[field.key] ?? ''}</td>
                        {/each}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <p class="text-sm text-base-content/40 text-center py-6">No records found.</p>
            {/if}

          {:else if view.definition.view_type === 'stats'}
            <div class="stats stats-horizontal w-full">
              {#each (view.data?.records ?? []).slice(0, 4) as record}
                <div class="stat">
                  <div class="stat-value text-2xl">{Object.values(record)[0]}</div>
                  <div class="stat-desc">{Object.keys(record)[0]}</div>
                </div>
              {/each}
            </div>

          {:else}
            <pre class="text-xs bg-base-300 rounded p-3 overflow-auto max-h-64">{JSON.stringify(view.data, null, 2)}</pre>
          {/if}
        </div>
      </div>
    {/each}

    {#if pageData.views.length === 0}
      <div class="text-center py-12 text-base-content/40 text-sm">
        No views configured for this page yet.
        {#if isAdmin}
          <a href="{base}/zones/intranet" class="text-primary hover:underline ml-1">Add views in Admin →</a>
        {/if}
      </div>
    {/if}
  </div>
{/if}
