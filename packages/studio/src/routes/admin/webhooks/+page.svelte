<script lang="ts">
  import { onMount } from 'svelte';
  import { webhooksApi } from '$lib/api.js';
  import { Plus, Trash2, Send, CheckCircle, XCircle } from '@lucide/svelte';

  let webhooks = $state<any[]>([]);
  let loading = $state(true);
  let showCreateModal = $state(false);
  let creating = $state(false);
  let testingId = $state<string | null>(null);

  let form = $state({
    name: '',
    url: '',
    events: [] as string[],
    secret: '',
    active: true,
  });

  const EVENT_OPTIONS = [
    'data.insert',
    'data.update',
    'data.delete',
    'collection.create',
    'collection.delete',
  ];

  onMount(async () => {
    await loadWebhooks();
  });

  async function loadWebhooks() {
    loading = true;
    try {
      webhooks = await webhooksApi.list();
    } finally {
      loading = false;
    }
  }

  function toggleEvent(ev: string) {
    if (form.events.includes(ev)) {
      form.events = form.events.filter((e) => e !== ev);
    } else {
      form.events = [...form.events, ev];
    }
  }

  async function createWebhook() {
    if (!form.name || !form.url || form.events.length === 0) return;
    creating = true;
    try {
      await webhooksApi.create(form);
      showCreateModal = false;
      form = { name: '', url: '', events: [], secret: '', active: true };
      await loadWebhooks();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create webhook');
    } finally {
      creating = false;
    }
  }

  async function deleteWebhook(id: string) {
    if (!confirm('Delete this webhook?')) return;
    await webhooksApi.delete(id);
    await loadWebhooks();
  }

  async function testWebhook(id: string) {
    testingId = id;
    try {
      const res = await webhooksApi.test(id);
      if (res.success) {
        alert('Test delivery succeeded!');
      } else {
        alert(`Test failed: ${res.error}`);
      }
    } finally {
      testingId = null;
    }
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Webhooks</h1>
      <p class="text-base-content/60 text-sm mt-1">HTTP callbacks triggered by data events</p>
    </div>
    <button class="btn btn-primary btn-sm gap-2" onclick={() => (showCreateModal = true)}>
      <Plus size={16} />
      New Webhook
    </button>
  </div>

  {#if loading}
    <div class="flex justify-center py-12">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else if webhooks.length === 0}
    <div class="card bg-base-200 text-center py-12">
      <p class="text-base-content/60">No webhooks configured</p>
      <button class="btn btn-primary btn-sm mt-4" onclick={() => (showCreateModal = true)}>
        Create First Webhook
      </button>
    </div>
  {:else}
    <div class="space-y-3">
      {#each webhooks as wh}
        <div class="card bg-base-200">
          <div class="card-body p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  <h3 class="font-semibold">{wh.name}</h3>
                  {#if wh.active}
                    <span class="badge badge-success badge-xs">active</span>
                  {:else}
                    <span class="badge badge-ghost badge-xs">inactive</span>
                  {/if}
                </div>
                <p class="text-sm font-mono text-base-content/60 truncate">{wh.url}</p>
                <div class="flex flex-wrap gap-1 mt-2">
                  {#each wh.events || [] as ev}
                    <span class="badge badge-outline badge-xs">{ev}</span>
                  {/each}
                </div>
                {#if wh.last_delivery_at}
                  <p class="text-xs text-base-content/40 mt-1">
                    Last delivery: {new Date(wh.last_delivery_at).toLocaleString()}
                    {#if wh.last_delivery_status === 200}
                      <CheckCircle size={12} class="inline text-success ml-1" />
                    {:else}
                      <XCircle size={12} class="inline text-error ml-1" />
                    {/if}
                  </p>
                {/if}
              </div>
              <div class="flex gap-1 shrink-0">
                <button
                  class="btn btn-ghost btn-xs gap-1"
                  onclick={() => testWebhook(wh.id)}
                  disabled={testingId === wh.id}
                >
                  {#if testingId === wh.id}
                    <span class="loading loading-spinner loading-xs"></span>
                  {:else}
                    <Send size={12} />
                  {/if}
                  Test
                </button>
                <button
                  class="btn btn-ghost btn-xs text-error"
                  onclick={() => deleteWebhook(wh.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if showCreateModal}
  <dialog class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">New Webhook</h3>

      <div class="space-y-3">
        <div class="form-control">
          <label class="label"><span class="label-text">Name</span></label>
          <input
            type="text"
            bind:value={form.name}
            placeholder="e.g. Notify Slack"
            class="input input-bordered"
          />
        </div>

        <div class="form-control">
          <label class="label"><span class="label-text">URL</span></label>
          <input
            type="url"
            bind:value={form.url}
            placeholder="https://hooks.slack.com/..."
            class="input input-bordered"
          />
        </div>

        <div class="form-control">
          <label class="label"><span class="label-text">Events</span></label>
          <div class="flex flex-wrap gap-2">
            {#each EVENT_OPTIONS as ev}
              <label class="label cursor-pointer gap-2">
                <input
                  type="checkbox"
                  class="checkbox checkbox-sm"
                  checked={form.events.includes(ev)}
                  onchange={() => toggleEvent(ev)}
                />
                <span class="label-text text-sm font-mono">{ev}</span>
              </label>
            {/each}
          </div>
        </div>

        <div class="form-control">
          <label class="label"><span class="label-text">Secret (optional, for HMAC-SHA256)</span></label>
          <input
            type="text"
            bind:value={form.secret}
            placeholder="my-webhook-secret"
            class="input input-bordered input-sm font-mono"
          />
        </div>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
        <button
          class="btn btn-primary"
          onclick={createWebhook}
          disabled={creating || !form.name || !form.url || form.events.length === 0}
        >
          {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
          Create
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
  </dialog>
{/if}
