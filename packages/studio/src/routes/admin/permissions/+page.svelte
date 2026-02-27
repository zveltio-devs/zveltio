<script lang="ts">
  import { onMount } from 'svelte';
  import { ENGINE_URL } from '$lib/config.js';
  import { Plus, Trash2 } from '@lucide/svelte';

  interface Policy {
    subject: string;
    resource: string;
    action: string;
  }

  let policies = $state<Policy[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let showAddModal = $state(false);

  let newPolicy = $state({ subject: '', resource: '*', action: 'read' });

  const ACTIONS = ['read', 'create', 'update', 'delete', '*'];
  const COMMON_SUBJECTS = ['admin', 'manager', 'member'];

  onMount(async () => {
    await loadPolicies();
  });

  async function loadPolicies() {
    loading = true;
    try {
      const res = await fetch(`${ENGINE_URL}/api/permissions/policies`, { credentials: 'include' });
      const data = await res.json();
      policies = data.policies || [];
    } finally {
      loading = false;
    }
  }

  async function addPolicy() {
    if (!newPolicy.subject || !newPolicy.resource) return;
    saving = true;
    try {
      await fetch(`${ENGINE_URL}/api/permissions/policies`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newPolicy),
      });
      showAddModal = false;
      newPolicy = { subject: '', resource: '*', action: 'read' };
      await loadPolicies();
    } finally {
      saving = false;
    }
  }

  async function deletePolicy(policy: Policy) {
    if (!confirm(`Remove policy: ${policy.subject} → ${policy.action} ${policy.resource}?`)) return;
    await fetch(`${ENGINE_URL}/api/permissions/policies`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy),
    });
    await loadPolicies();
  }

  function actionColor(action: string) {
    if (action === '*') return 'badge-error';
    if (action === 'delete') return 'badge-warning';
    if (action === 'create' || action === 'update') return 'badge-info';
    return 'badge-ghost';
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Permissions</h1>
      <p class="text-base-content/60 text-sm mt-1">Casbin RBAC policies — who can do what</p>
    </div>
    <button class="btn btn-primary btn-sm gap-2" onclick={() => (showAddModal = true)}>
      <Plus size={16} />
      Add Policy
    </button>
  </div>

  <div class="card bg-base-200 p-4 text-sm">
    <p class="font-medium mb-1">How policies work</p>
    <p class="text-base-content/60">
      A policy grants a <strong>subject</strong> (role) permission to perform an <strong>action</strong>
      on a <strong>resource</strong> (collection name or <code>*</code> for all).
    </p>
  </div>

  {#if loading}
    <div class="flex justify-center py-12">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else}
    <div class="card bg-base-200">
      <div class="overflow-x-auto">
        <table class="table table-zebra">
          <thead>
            <tr>
              <th>Subject (Role)</th>
              <th>Resource</th>
              <th>Action</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each policies as policy}
              <tr>
                <td>
                  <span class="badge badge-outline badge-sm">{policy.subject}</span>
                </td>
                <td class="font-mono text-sm">{policy.resource}</td>
                <td>
                  <span class="badge badge-sm {actionColor(policy.action)}">{policy.action}</span>
                </td>
                <td>
                  <button
                    class="btn btn-ghost btn-xs text-error"
                    onclick={() => deletePolicy(policy)}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            {:else}
              <tr>
                <td colspan="4" class="text-center text-base-content/40 py-8">No policies yet</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

{#if showAddModal}
  <dialog class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">Add Policy</h3>

      <div class="space-y-3">
        <div class="form-control">
          <label class="label"><span class="label-text">Subject (role)</span></label>
          <input
            type="text"
            bind:value={newPolicy.subject}
            placeholder="admin, manager, member..."
            class="input input-bordered"
            list="subjects-list"
          />
          <datalist id="subjects-list">
            {#each COMMON_SUBJECTS as s}
              <option value={s}></option>
            {/each}
          </datalist>
        </div>

        <div class="form-control">
          <label class="label"><span class="label-text">Resource (collection name or *)</span></label>
          <input
            type="text"
            bind:value={newPolicy.resource}
            placeholder="posts, users, * (all)"
            class="input input-bordered"
          />
        </div>

        <div class="form-control">
          <label class="label"><span class="label-text">Action</span></label>
          <select bind:value={newPolicy.action} class="select select-bordered">
            {#each ACTIONS as a}
              <option value={a}>{a}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showAddModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={addPolicy} disabled={saving}>
          {#if saving}<span class="loading loading-spinner loading-sm"></span>{/if}
          Add Policy
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showAddModal = false)}></button>
  </dialog>
{/if}
