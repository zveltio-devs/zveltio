<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import {
  Building2,
  RefreshCw,
  PauseCircle,
  PlayCircle,
  Layers,
  ChevronDown,
  ChevronUp,
  X,
  Check,
  Plus,
} from '@lucide/svelte';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import CrudListPage from '$lib/components/common/CrudListPage.svelte';
import { toast } from '$lib/stores/toast.svelte.js';

// ── State ──────────────────────────────────────────────────────────────────
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
let tenants = $state<any[]>([]);
let loading = $state(false);

// Create tenant modal
let showCreateModal = $state(false);
let creating = $state(false);
let createForm = $state({
  slug: '',
  name: '',
  admin_user_email: '',
});
let createError = $state('');

// Environments panel
let expandedTenant = $state<string | null>(null);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
let envsByTenant = $state<Record<string, any[]>>({});
let loadingEnvs = $state<string | null>(null);

// Create environment modal
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
let creatingEnvForTenant = $state<any>(null);
let envForm = $state({ slug: '', name: '' });
let creatingEnv = $state(false);
let createEnvError = $state('');

let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });

// ── Lifecycle ──────────────────────────────────────────────────────────────
onMount(loadTenants);

// ── API helpers ────────────────────────────────────────────────────────────
async function loadTenants() {
  loading = true;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const data = await api.get<{ tenants: any[] }>('/api/tenants');
    tenants = data.tenants;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  } catch (e: any) {
    toast.error(e.message ?? m['common.somethingWrong']());
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
      admin_user_email: createForm.admin_user_email,
    });
    showCreateModal = false;
    createForm = { slug: '', name: '', admin_user_email: '' };
    await loadTenants();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  } catch (e: any) {
    createError = e.message;
  } finally {
    creating = false;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
async function suspendTenant(tenant: any) {
  const newStatus = tenant.status === 'active' ? 'suspended' : 'active';
  const suspending = newStatus === 'suspended';
  confirmState = {
    open: true,
    title: suspending ? m['tenants.suspendTitle']() : m['tenants.reactivateTitle'](),
    message: suspending
      ? m['tenants.suspendMsg']({ name: tenant.name })
      : m['tenants.reactivateMsg']({ name: tenant.name }),
    confirmLabel: suspending ? m['tenants.suspend']() : m['tenants.reactivate'](),
    onconfirm: async () => {
      confirmState.open = false;
      try {
        await api.patch(`/api/tenants/${tenant.id}`, { status: newStatus });
        await loadTenants();
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      } catch (e: any) {
        toast.error(e.message);
      }
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
async function toggleEnvironments(tenant: any) {
  if (expandedTenant === tenant.id) {
    expandedTenant = null;
    return;
  }
  expandedTenant = tenant.id;
  if (!envsByTenant[tenant.id]) {
    loadingEnvs = tenant.id;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const data = await api.get<{ environments: any[] }>(`/api/tenants/${tenant.id}/environments`);
      envsByTenant[tenant.id] = data.environments;
    } catch (e) {
      // Leave the entry absent rather than caching `[]`: the guard above treats
      // any present entry as loaded, so a failed fetch read as "no environments"
      // until the page was reloaded.
      toast.error(e instanceof Error ? e.message : m['common.loadFailed']());
    } finally {
      loadingEnvs = null;
    }
  }
  if (!membersByTenant[tenant.id]) await loadMembers(tenant.id);
}

// ── Members + per-tenant roles ──────────────────────────────────────────────
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
let membersByTenant = $state<Record<string, any[]>>({});
let loadingMembers = $state<string | null>(null);
let memberForm = $state<Record<string, { email: string; role: string }>>({});
let addingMember = $state<string | null>(null);
const TENANT_ROLES = ['owner', 'admin', 'member', 'viewer'];

async function loadMembers(tenantId: string) {
  loadingMembers = tenantId;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const data = await api.get<{ members: any[] }>(`/api/tenants/${tenantId}/members`);
    membersByTenant[tenantId] = data.members;
  } catch (e) {
    // Same as the environments fetch: a cached `[]` is indistinguishable from a
    // tenant that genuinely has no members.
    toast.error(e instanceof Error ? e.message : m['common.loadFailed']());
  } finally {
    loadingMembers = null;
  }
}

async function addMember(tenantId: string) {
  const form = memberForm[tenantId] ?? { email: '', role: 'member' };
  if (!form.email) return;
  addingMember = tenantId;
  try {
    await api.post(`/api/tenants/${tenantId}/members`, {
      user_email: form.email,
      role: form.role || 'member',
    });
    memberForm[tenantId] = { email: '', role: 'member' };
    await loadMembers(tenantId);
    toast.success(m['tenants.memberAdded']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  } catch (e: any) {
    toast.error(e?.message ?? m['tenants.addMemberFailed']());
  } finally {
    addingMember = null;
  }
}

// Removing a member revokes that person's access to the tenant at once; every
// other destructive action on this screen asks first.
function confirmRemoveMember(tenantId: string, member: { user_id: string; email: string }) {
  confirmState = {
    open: true,
    title: m['tenants.removeMember'](),
    message: m['tenants.removeMemberMsg']({ email: member.email }),
    confirmLabel: m['common.remove'](),
    onconfirm: () => {
      confirmState.open = false;
      void removeMember(tenantId, member.user_id);
    },
  };
}

async function removeMember(tenantId: string, userId: string) {
  try {
    await api.delete(`/api/tenants/${tenantId}/members/${userId}`);
    await loadMembers(tenantId);
    toast.success(m['tenants.memberRemoved']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  } catch (e: any) {
    toast.error(e?.message ?? m['tenants.removeMemberFailed']());
  }
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const data = await api.get<{ environments: any[] }>(
      `/api/tenants/${creatingEnvForTenant.id}/environments`,
    );
    envsByTenant[creatingEnvForTenant.id] = data.environments;
    creatingEnvForTenant = null;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  } catch (e: any) {
    createEnvError = e.message;
  } finally {
    creatingEnv = false;
  }
}
</script>

<CrudListPage
  title={m['nav.tenants']()}
  subtitle={m['tenants.subtitle']()}
  count={tenants.length}
  loading={loading && tenants.length === 0}
  actionLabel={m['tenants.newTenant']()}
  onAction={() => (showCreateModal = true)}
  empty={{
    illustration: 'cloud',
    illustrationColor: 'text-secondary',
    title: m['tenants.emptyTitle'](),
    description: m['tenants.emptyDesc'](),
    actionLabel: m['tenants.createTenant'](),
    onAction: () => (showCreateModal = true),
  }}
>
  {#snippet headerExtras()}
    <div class="flex justify-end">
      <button class="btn btn-ghost btn-sm gap-2" onclick={loadTenants} disabled={loading} aria-label={m['tenants.refresh']()}>
        <RefreshCw size={16} class={loading ? 'animate-spin' : ''} />
        {m['common.refresh']()}
      </button>
    </div>
  {/snippet}

  {#snippet list()}
    <div class="card bg-base-100 shadow-sm overflow-x-auto">
      <table class="table table-sm w-full">
 <thead>
 <tr>
 <th>{m['tenants.tenant']()}</th>
 <th>{m['common.col.status']()}</th>
 <th class="text-right">{m['common.actions']()}</th>
 </tr>
 </thead>
 <tbody>
 {#each tenants as tenant}
 <!-- Main row -->
 <tr class="hover group">
 <td>
 <div class="font-medium text-sm">{tenant.name}</div>
 <div class="text-xs text-base-content/65 font-mono">{tenant.slug}</div>
 </td>
 <td>
 <span class="badge badge-xs {tenant.status === 'active' ? 'badge-success' : 'badge-error'}">{tenant.status ?? 'active'}</span>
 </td>
 <td class="text-right">
 <div class="flex gap-1 justify-end">
 <!-- Environments toggle -->
 <button
 class="btn btn-ghost btn-xs gap-1 tooltip"
 data-tip={m['tenants.environments']()}
 onclick={() => toggleEnvironments(tenant)}
 >
 <Layers size={14} />
 {#if expandedTenant === tenant.id}
 <ChevronUp size={12} />
 {:else}
 <ChevronDown size={12} />
 {/if}
 </button>

 <!-- Suspend / Reactivate -->
 {#if tenant.status !== 'deleted'}
 <button
 class="btn btn-ghost btn-xs tooltip"
 data-tip={tenant.status === 'active' ? m['tenants.suspend']() : m['tenants.reactivate']()}
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
 <td colspan="3" class="py-3 px-6">
 <div class="flex items-center justify-between mb-2">
 <span class="text-sm font-semibold opacity-70">{m['tenants.environments']()}</span>
 <button
 class="btn btn-ghost btn-xs gap-1"
 onclick={() => openCreateEnv(tenant)}
 >
 <Plus size={12} />
 {m['tenants.addEnvironment']()}
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
 <span class="text-xs opacity-50">{m['tenants.noEnvironments']()}</span>
 {/if}
 </div>
 {/if}

 <!-- Members + per-tenant roles -->
 <div class="divider my-3"></div>
 <span class="text-sm font-semibold opacity-70">{m['tenants.membersRoles']()}</span>
 {#if loadingMembers === tenant.id}
 <span class="loading loading-dots loading-sm"></span>
 {:else}
 <div class="overflow-x-auto mt-2">
 <table class="table table-xs">
 <tbody>
 <!--
 Loop variable named `member`, not `m`: `m` is the message catalogue
 imported at the top of this file, and `{#each … as m}` shadows it for
 the whole block. `m['tenants.removeMember']()` then read a property off
 the member object and called `undefined`, so this table threw as soon as
 a tenant had a single member.
 -->
 {#each membersByTenant[tenant.id] ?? [] as member}
 <tr>
 <td class="font-mono">{member.email}</td>
 <td><span class="badge badge-sm badge-outline">{member.role}</span></td>
 <td class="text-right">
 <button
 class="btn btn-ghost btn-xs text-error"
 title={m['tenants.removeMember']()}
 onclick={() => confirmRemoveMember(tenant.id, member)}
 >{m['common.remove']()}</button>
 </td>
 </tr>
 {/each}
 {#if (membersByTenant[tenant.id] ?? []).length === 0}
 <tr><td class="text-xs opacity-50">{m['tenants.noMembers']()}</td></tr>
 {/if}
 </tbody>
 </table>
 </div>
 <div class="flex flex-wrap items-center gap-2 mt-2">
 <input
 type="email"
 placeholder="user@email"
 class="input input-bordered input-xs w-56"
 value={memberForm[tenant.id]?.email ?? ''}
 oninput={(e) =>
 (memberForm[tenant.id] = {
 email: e.currentTarget.value,
 role: memberForm[tenant.id]?.role ?? 'member',
 })}
 />
 <select
 class="select select-bordered select-xs"
 value={memberForm[tenant.id]?.role ?? 'member'}
 onchange={(e) =>
 (memberForm[tenant.id] = {
 email: memberForm[tenant.id]?.email ?? '',
 role: e.currentTarget.value,
 })}
 >
 {#each TENANT_ROLES as r}
 <option value={r}>{r}</option>
 {/each}
 </select>
 <button
 class="btn btn-primary btn-xs gap-1"
 disabled={addingMember === tenant.id || !(memberForm[tenant.id]?.email)}
 onclick={() => addMember(tenant.id)}
 >
 <Plus size={12} />
 {m['tenants.addMember']()}
 </button>
 </div>
 {/if}
 </td>
 </tr>
 {/if}
 {/each}
 </tbody>
      </table>
    </div>
  {/snippet}
</CrudListPage>

<!-- ── Create Tenant Modal ─────────────────────────────────────────────────── -->
{#if showCreateModal}
 <div class="modal modal-open">
 <div class="modal-box max-w-lg">
 <div class="flex items-center justify-between mb-4">
 <h3 class="font-bold text-lg">{m['tenants.create']()}</h3>
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
 <span class="label-text">{m['common.col.slug']()} <span class="text-error">*</span></span>
 <span class="label-text-alt opacity-60">{m['tenants.slugHint']()}</span>
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
 <span class="label-text">{m['common.col.name']()} <span class="text-error">*</span></span>
 </label>
 <input
 id="tenant-name"
 type="text"
 class="input"
 placeholder={m['tenants.phCompany']()}
 bind:value={createForm.name}
 />
 </div>

 <div class="form-control">
 <label class="label" for="tenant-admin-email">
 <span class="label-text">{m['tenants.adminEmail']()} <span class="text-error">*</span></span>
 <span class="label-text-alt opacity-60">{m['tenants.mustExist']()}</span>
 </label>
 <input
 id="tenant-admin-email"
 type="email"
 class="input"
 placeholder="admin@mycompany.com"
 bind:value={createForm.admin_user_email}
 />
 </div>

 </div>

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>{m['common.cancel']()}</button>
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
 {m['tenants.createTenant']()}
 </button>
 </div>
 </div>
 <div
 class="modal-backdrop"
 role="button"
 tabindex="0"
 aria-label={m['common.close']()}
 onclick={() => (showCreateModal = false)}
 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') showCreateModal = false; }}
 ></div>
 </div>
{/if}

<!-- ── Create Environment Modal ───────────────────────────────────────────── -->
{#if creatingEnvForTenant}
 <div class="modal modal-open">
 <div class="modal-box max-w-md">
 <div class="flex items-center justify-between mb-4">
 <h3 class="font-bold text-lg">{m['tenants.addEnvironment']()}</h3>
 <button
 class="btn btn-ghost btn-sm btn-circle"
 onclick={() => (creatingEnvForTenant = null)}
 >
 <X size={16} />
 </button>
 </div>

 <p class="text-sm opacity-60 mb-3">
 {m['tenants.tenantLabel']({ name: creatingEnvForTenant.name })}
 </p>

 {#if createEnvError}
 <div class="alert alert-error mb-3 text-sm">{createEnvError}</div>
 {/if}

 <div class="space-y-3">
 <div class="form-control">
 <label class="label" for="env-slug">
 <span class="label-text">{m['common.col.slug']()} <span class="text-error">*</span></span>
 <span class="label-text-alt opacity-60">{m['tenants.envHint']()}</span>
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
 <span class="label-text">{m['common.col.name']()} <span class="text-error">*</span></span>
 </label>
 <input
 id="env-name"
 type="text"
 class="input"
 placeholder={m['tenants.phEnv']()}
 bind:value={envForm.name}
 />
 </div>
 </div>

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (creatingEnvForTenant = null)}>{m['common.cancel']()}</button>
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
 {m['common.create']()}
 </button>
 </div>
 </div>
 <div
 class="modal-backdrop"
 role="button"
 tabindex="0"
 aria-label={m['common.close']()}
 onclick={() => (creatingEnvForTenant = null)}
 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') creatingEnvForTenant = null; }}
 ></div>
 </div>
{/if}

<ConfirmModal
 open={confirmState.open}
 title={confirmState.title}
 message={confirmState.message}
 confirmLabel={confirmState.confirmLabel ?? m['common.confirm']()}
 onconfirm={confirmState.onconfirm}
 oncancel={() => (confirmState.open = false)}
/>
