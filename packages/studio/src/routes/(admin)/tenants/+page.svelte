<script lang="ts">
 import { onMount } from 'svelte';
 import { api } from '$lib/api.js';
 import {
 Building2,
 Plus,
 RefreshCw,
 Edit,
 PauseCircle,
 PlayCircle,
 Layers,
 ChevronDown,
 ChevronUp,
 X,
 Check,
 } from '@lucide/svelte';
 import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
 import { toast } from '$lib/stores/toast.svelte.js';

 // ── State ──────────────────────────────────────────────────────────────────
 let tenants = $state<any[]>([]);
 let loading = $state(false);

 // Create tenant modal
 let showCreateModal = $state(false);
 let creating = $state(false);
 let createForm = $state({
 slug: '',
 name: '',
 plan: 'free',
 billing_email: '',
 admin_user_email: '',
 });
 let createError = $state('');

 // Edit limits modal
 let editingTenant = $state<any>(null);
 let editForm = $state<any>({});
 let saving = $state(false);

 // Environments panel
 let expandedTenant = $state<string | null>(null);
 let envsByTenant = $state<Record<string, any[]>>({});
 let loadingEnvs = $state<string | null>(null);

 // Create environment modal
 let creatingEnvForTenant = $state<any>(null);
 let envForm = $state({ slug: '', name: '' });
 let creatingEnv = $state(false);
 let createEnvError = $state('');

 let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

 // ── Lifecycle ──────────────────────────────────────────────────────────────
 onMount(loadTenants);

 // ── API helpers ────────────────────────────────────────────────────────────
 async function loadTenants() {
 loading = true;
 try {
 const data = await api.get<{ tenants: any[] }>('/api/tenants');
 tenants = data.tenants;
 } catch (e: any) {
 toast.error(e.message ?? 'Something went wrong');
 } finally {
 loading = false;
 }
 }

 async function createTenant() {
 creating = true;
 createError = '';
 try {
 await api.post('/api/tenants', {
 slug: createForm.slug,
 name: createForm.name,
 plan: createForm.plan,
 billing_email: createForm.billing_email || undefined,
 admin_user_email: createForm.admin_user_email,
 });
 showCreateModal = false;
 createForm = { slug: '', name: '', plan: 'free', billing_email: '', admin_user_email: '' };
 await loadTenants();
 } catch (e: any) {
 createError = e.message;
 } finally {
 creating = false;
 }
 }

 async function suspendTenant(tenant: any) {
 const newStatus = tenant.status === 'active' ? 'suspended' : 'active';
 const action = newStatus === 'suspended' ? 'Suspend' : 'Reactivate';
 confirmState = {
 open: true,
 title: `${action} Tenant`,
 message: `${action} tenant "${tenant.name}"?`,
 confirmLabel: action,
 onconfirm: async () => {
 confirmState.open = false;
 try {
 await api.patch(`/api/tenants/${tenant.id}`, { status: newStatus });
 await loadTenants();
 } catch (e: any) {
 toast.error(e.message);
 }
 },
 };
 }

 function openEditLimits(tenant: any) {
 editingTenant = tenant;
 editForm = {
 max_records: tenant.max_records,
 max_storage_gb: tenant.max_storage_gb,
 max_api_calls_day: tenant.max_api_calls_day,
 max_users: tenant.max_users,
 plan: tenant.plan,
 };
 }

 async function saveLimits() {
 saving = true;
 try {
 await api.patch(`/api/tenants/${editingTenant.id}`, editForm);
 editingTenant = null;
 await loadTenants();
 } catch (e: any) {
 toast.error(e.message);
 } finally {
 saving = false;
 }
 }

 async function toggleEnvironments(tenant: any) {
 if (expandedTenant === tenant.id) {
 expandedTenant = null;
 return;
 }
 expandedTenant = tenant.id;
 if (!envsByTenant[tenant.id]) {
 loadingEnvs = tenant.id;
 try {
 const data = await api.get<{ environments: any[] }>(`/api/tenants/${tenant.id}/environments`);
 envsByTenant[tenant.id] = data.environments;
 } catch {
 envsByTenant[tenant.id] = [];
 } finally {
 loadingEnvs = null;
 }
 }
 }

 function openCreateEnv(tenant: any) {
 creatingEnvForTenant = tenant;
 envForm = { slug: '', name: '' };
 createEnvError = '';
 }

 async function createEnvironment() {
 creatingEnv = true;
 createEnvError = '';
 try {
 await api.post(`/api/tenants/${creatingEnvForTenant.id}/environments`, envForm);
 const data = await api.get<{ environments: any[] }>(`/api/tenants/${creatingEnvForTenant.id}/environments`);
 envsByTenant[creatingEnvForTenant.id] = data.environments;
 creatingEnvForTenant = null;
 } catch (e: any) {
 createEnvError = e.message;
 } finally {
 creatingEnv = false;
 }
 }

 // ── Helpers ────────────────────────────────────────────────────────────────
 const planBadge: Record<string, string> = {
 free: 'badge-ghost',
 pro: 'badge-primary',
 enterprise: 'badge-secondary',
 custom: 'badge-accent',
 };

 const statusBadge: Record<string, string> = {
 active: 'badge-success',
 suspended: 'badge-warning',
 deleted: 'badge-error',
 };
</script>

<div class="p-6">
 <!-- Header -->
 <div class="flex items-center justify-between mb-6">
 <div>
 <h1 class="text-3xl font-bold flex items-center gap-3">
 <Building2 size={32} />
 Tenants
 </h1>
 <p class="text-lg opacity-70 mt-1">Manage SaaS tenants and their environments</p>
 </div>
 <div class="flex gap-2">
 <button class="btn btn-ghost btn-sm gap-2" onclick={loadTenants} disabled={loading}>
 <RefreshCw size={16} class={loading ? 'animate-spin' : ''} />
 Refresh
 </button>
 <button class="btn btn-primary gap-2" onclick={() => (showCreateModal = true)}>
 <Plus size={18} />
 New Tenant
 </button>
 </div>
 </div>

 <!-- Tenants table -->
 <div class="card bg-base-100 shadow-xl">
 <div class="card-body p-0">
 {#if loading && tenants.length === 0}
 <div class="flex justify-center py-16">
 <span class="loading loading-spinner loading-lg"></span>
 </div>
 {:else if tenants.length === 0}
 <div class="text-center py-16">
 <Building2 size={48} class="mx-auto opacity-30 mb-3" />
 <p class="opacity-60">No tenants yet. Create the first one.</p>
 </div>
 {:else}
 <div class="overflow-x-auto">
 <table class="table">
 <thead>
 <tr>
 <th>Tenant</th>
 <th>Plan</th>
 <th>Status</th>
 <th>Limits</th>
 <th>Created</th>
 <th>Actions</th>
 </tr>
 </thead>
 <tbody>
 {#each tenants as tenant}
 <!-- Main row -->
 <tr class="hover">
 <td>
 <div>
 <span class="font-semibold">{tenant.name}</span>
 <br />
 <code class="text-xs opacity-60">{tenant.slug}</code>
 </div>
 </td>
 <td>
 <span class="badge {planBadge[tenant.plan] ?? 'badge-ghost'}">{tenant.plan}</span>
 </td>
 <td>
 <span class="badge {statusBadge[tenant.status] ?? 'badge-ghost'}">
 {tenant.status}
 </span>
 </td>
 <td class="text-xs opacity-70">
 <div>{tenant.max_records.toLocaleString()} records</div>
 <div>{tenant.max_api_calls_day.toLocaleString()} calls/day</div>
 <div>{tenant.max_users} users</div>
 </td>
 <td class="text-xs opacity-60">
 {new Date(tenant.created_at).toLocaleDateString()}
 </td>
 <td>
 <div class="flex gap-1">
 <!-- Environments toggle -->
 <button
 class="btn btn-ghost btn-xs gap-1 tooltip"
 data-tip="Environments"
 onclick={() => toggleEnvironments(tenant)}
 >
 <Layers size={14} />
 {#if expandedTenant === tenant.id}
 <ChevronUp size={12} />
 {:else}
 <ChevronDown size={12} />
 {/if}
 </button>

 <!-- Edit limits -->
 <button
 class="btn btn-ghost btn-xs tooltip"
 data-tip="Edit Limits"
 onclick={() => openEditLimits(tenant)}
 >
 <Edit size={14} />
 </button>

 <!-- Suspend / Reactivate -->
 {#if tenant.status !== 'deleted'}
 <button
 class="btn btn-ghost btn-xs tooltip"
 data-tip={tenant.status === 'active' ? 'Suspend' : 'Reactivate'}
 onclick={() => suspendTenant(tenant)}
 >
 {#if tenant.status === 'active'}
 <PauseCircle size={14} class="text-warning" />
 {:else}
 <PlayCircle size={14} class="text-success" />
 {/if}
 </button>
 {/if}
 </div>
 </td>
 </tr>

 <!-- Environments row (expandable) -->
 {#if expandedTenant === tenant.id}
 <tr class="bg-base-200">
 <td colspan="6" class="py-3 px-6">
 <div class="flex items-center justify-between mb-2">
 <span class="text-sm font-semibold opacity-70">Environments</span>
 <button
 class="btn btn-ghost btn-xs gap-1"
 onclick={() => openCreateEnv(tenant)}
 >
 <Plus size={12} />
 Add Environment
 </button>
 </div>

 {#if loadingEnvs === tenant.id}
 <span class="loading loading-dots loading-sm"></span>
 {:else}
 <div class="flex flex-wrap gap-2">
 {#each envsByTenant[tenant.id] ?? [] as env}
 <div
 class="badge gap-2 badge-lg font-mono"
 style="border-left: 4px solid {env.color}; padding-left: 10px;"
 >
 <span
 class="w-2 h-2 rounded-full inline-block"
 style="background:{env.color}"
 ></span>
 {env.name}
 <span class="opacity-60 text-xs">({env.slug})</span>
 {#if env.is_production}
 <span class="badge badge-xs badge-error">prod</span>
 {/if}
 </div>
 {/each}
 {#if (envsByTenant[tenant.id] ?? []).length === 0}
 <span class="text-xs opacity-50">No environments yet</span>
 {/if}
 </div>
 {/if}
 </td>
 </tr>
 {/if}
 {/each}
 </tbody>
 </table>
 </div>
 {/if}
 </div>
 </div>
</div>

<!-- ── Create Tenant Modal ─────────────────────────────────────────────────── -->
{#if showCreateModal}
 <div class="modal modal-open">
 <div class="modal-box max-w-lg">
 <div class="flex items-center justify-between mb-4">
 <h3 class="font-bold text-lg">Create New Tenant</h3>
 <button class="btn btn-ghost btn-sm btn-circle" onclick={() => (showCreateModal = false)}>
 <X size={16} />
 </button>
 </div>

 {#if createError}
 <div class="alert alert-error mb-3 text-sm">{createError}</div>
 {/if}

 <div class="space-y-3">
 <div class="form-control">
 <label class="label" for="tenant-slug">
 <span class="label-text">Slug <span class="text-error">*</span></span>
 <span class="label-text-alt opacity-60">Lowercase, hyphens only</span>
 </label>
 <input
 id="tenant-slug"
 type="text"
 class="input"
 placeholder="my-company"
 bind:value={createForm.slug}
 />
 </div>

 <div class="form-control">
 <label class="label" for="tenant-name">
 <span class="label-text">Name <span class="text-error">*</span></span>
 </label>
 <input
 id="tenant-name"
 type="text"
 class="input"
 placeholder="My Company"
 bind:value={createForm.name}
 />
 </div>

 <div class="form-control">
 <label class="label" for="tenant-plan">
 <span class="label-text">Plan</span>
 </label>
 <select id="tenant-plan" class="select" bind:value={createForm.plan}>
 <option value="free">Free</option>
 <option value="pro">Pro</option>
 <option value="enterprise">Enterprise</option>
 <option value="custom">Custom</option>
 </select>
 </div>

 <div class="form-control">
 <label class="label" for="tenant-admin-email">
 <span class="label-text">Admin User Email <span class="text-error">*</span></span>
 <span class="label-text-alt opacity-60">Must already exist</span>
 </label>
 <input
 id="tenant-admin-email"
 type="email"
 class="input"
 placeholder="admin@mycompany.com"
 bind:value={createForm.admin_user_email}
 />
 </div>

 <div class="form-control">
 <label class="label" for="tenant-billing-email">
 <span class="label-text">Billing Email</span>
 <span class="label-text-alt opacity-60">Optional</span>
 </label>
 <input
 id="tenant-billing-email"
 type="email"
 class="input"
 placeholder="billing@mycompany.com"
 bind:value={createForm.billing_email}
 />
 </div>
 </div>

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
 <button
 class="btn btn-primary gap-2"
 onclick={createTenant}
 disabled={creating || !createForm.slug || !createForm.name || !createForm.admin_user_email}
 >
 {#if creating}
 <span class="loading loading-spinner loading-sm"></span>
 {:else}
 <Check size={16} />
 {/if}
 Create Tenant
 </button>
 </div>
 </div>
 <div
 class="modal-backdrop"
 role="button"
 tabindex="0"
 aria-label="Close"
 onclick={() => (showCreateModal = false)}
 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') showCreateModal = false; }}
 ></div>
 </div>
{/if}

<!-- ── Edit Limits Modal ───────────────────────────────────────────────────── -->
{#if editingTenant}
 <div class="modal modal-open">
 <div class="modal-box max-w-md">
 <div class="flex items-center justify-between mb-4">
 <h3 class="font-bold text-lg">Edit Limits — {editingTenant.name}</h3>
 <button class="btn btn-ghost btn-sm btn-circle" onclick={() => (editingTenant = null)}>
 <X size={16} />
 </button>
 </div>

 <div class="space-y-3">
 <div class="form-control">
 <label class="label" for="edit-plan">
 <span class="label-text">Plan</span>
 </label>
 <select id="edit-plan" class="select" bind:value={editForm.plan}>
 <option value="free">Free</option>
 <option value="pro">Pro</option>
 <option value="enterprise">Enterprise</option>
 <option value="custom">Custom</option>
 </select>
 </div>

 <div class="form-control">
 <label class="label" for="edit-max-records">
 <span class="label-text">Max Records</span>
 </label>
 <input
 id="edit-max-records"
 type="number"
 class="input"
 bind:value={editForm.max_records}
 />
 </div>

 <div class="form-control">
 <label class="label" for="edit-max-storage">
 <span class="label-text">Max Storage (GB)</span>
 </label>
 <input
 id="edit-max-storage"
 type="number"
 step="0.1"
 class="input"
 bind:value={editForm.max_storage_gb}
 />
 </div>

 <div class="form-control">
 <label class="label" for="edit-max-api">
 <span class="label-text">Max API Calls / Day</span>
 </label>
 <input
 id="edit-max-api"
 type="number"
 class="input"
 bind:value={editForm.max_api_calls_day}
 />
 </div>

 <div class="form-control">
 <label class="label" for="edit-max-users">
 <span class="label-text">Max Users</span>
 </label>
 <input
 id="edit-max-users"
 type="number"
 class="input"
 bind:value={editForm.max_users}
 />
 </div>
 </div>

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (editingTenant = null)}>Cancel</button>
 <button class="btn btn-primary gap-2" onclick={saveLimits} disabled={saving}>
 {#if saving}
 <span class="loading loading-spinner loading-sm"></span>
 {:else}
 <Check size={16} />
 {/if}
 Save
 </button>
 </div>
 </div>
 <div
 class="modal-backdrop"
 role="button"
 tabindex="0"
 aria-label="Close"
 onclick={() => (editingTenant = null)}
 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') editingTenant = null; }}
 ></div>
 </div>
{/if}

<!-- ── Create Environment Modal ───────────────────────────────────────────── -->
{#if creatingEnvForTenant}
 <div class="modal modal-open">
 <div class="modal-box max-w-sm">
 <div class="flex items-center justify-between mb-4">
 <h3 class="font-bold text-lg">Add Environment</h3>
 <button
 class="btn btn-ghost btn-sm btn-circle"
 onclick={() => (creatingEnvForTenant = null)}
 >
 <X size={16} />
 </button>
 </div>

 <p class="text-sm opacity-60 mb-3">
 Tenant: <strong>{creatingEnvForTenant.name}</strong>
 </p>

 {#if createEnvError}
 <div class="alert alert-error mb-3 text-sm">{createEnvError}</div>
 {/if}

 <div class="space-y-3">
 <div class="form-control">
 <label class="label" for="env-slug">
 <span class="label-text">Slug <span class="text-error">*</span></span>
 <span class="label-text-alt opacity-60">e.g. staging</span>
 </label>
 <input
 id="env-slug"
 type="text"
 class="input"
 placeholder="staging"
 bind:value={envForm.slug}
 />
 </div>

 <div class="form-control">
 <label class="label" for="env-name">
 <span class="label-text">Name <span class="text-error">*</span></span>
 </label>
 <input
 id="env-name"
 type="text"
 class="input"
 placeholder="Staging"
 bind:value={envForm.name}
 />
 </div>
 </div>

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (creatingEnvForTenant = null)}>Cancel</button>
 <button
 class="btn btn-primary gap-2"
 onclick={createEnvironment}
 disabled={creatingEnv || !envForm.slug || !envForm.name}
 >
 {#if creatingEnv}
 <span class="loading loading-spinner loading-sm"></span>
 {:else}
 <Check size={16} />
 {/if}
 Create
 </button>
 </div>
 </div>
 <div
 class="modal-backdrop"
 role="button"
 tabindex="0"
 aria-label="Close"
 onclick={() => (creatingEnvForTenant = null)}
 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') creatingEnvForTenant = null; }}
 ></div>
 </div>
{/if}

<ConfirmModal
 open={confirmState.open}
 title={confirmState.title}
 message={confirmState.message}
 confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
 onconfirm={confirmState.onconfirm}
 oncancel={() => (confirmState.open = false)}
/>
