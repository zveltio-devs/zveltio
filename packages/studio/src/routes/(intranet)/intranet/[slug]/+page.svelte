<script lang="ts">
  import { page } from '$app/state';
  import { api } from '$lib/api.js';

  const ZONE_SLUG = 'intranet';

  let pageData = $state<{ page: any; zone: any; views: any[] } | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const slug = $derived(page.params.slug);

  // Re-fetch whenever the slug changes (navigation between zone pages)
  $effect(() => {
    const s = slug;
    loading = true;
    error = null;
    pageData = null;
    api.get<{ page: any; zone: any; views: any[] }>(`/api/zones/${ZONE_SLUG}/render/${s}`)
      .then((res) => { pageData = res; })
      .catch((e: any) => { error = e?.message ?? 'Page not found'; })
      .finally(() => { loading = false; });
  });
</script>

{#if loading}
  <div class="flex items-center justify-center py-20">
    <span class="loading loading-spinner loading-md text-primary"></span>
  </div>

{:else if error}
  <div class="alert alert-error max-w-md mx-auto mt-10">
    <span>{error}</span>
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
        No views configured for this page.
      </div>
    {/if}
  </div>
{/if}
