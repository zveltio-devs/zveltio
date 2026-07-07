<script lang="ts">
import { onMount } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { usersApi } from '$lib/api.js';
import { UserPlus, Users, Shield, Trash2 } from '@lucide/svelte';
import { base } from '$app/paths';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import Pagination from '$lib/components/common/Pagination.svelte';
import { toast } from '$lib/stores/toast.svelte.js';
import CrudListPage from '$lib/components/common/CrudListPage.svelte';
import InlineEdit from '$lib/components/common/InlineEdit.svelte';
import SchemaForm from '$lib/components/common/SchemaForm.svelte';
import { auth } from '$lib/auth.svelte.js';
import type { FormSchema } from '@zveltio/sdk/extension';

// S3-02: schema-driven invite form so extensions can register form-alter
// hooks against `core:user-invite` (e.g. add `preferred_language`, hide
// `name` for tenants that don't want it, attach extra validators).
const inviteSchema: FormSchema = {
  id: 'core:user-invite',
  fields: [
    {
      name: 'email',
      type: 'email',
      label: 'Email',
      required: true,
      placeholder: 'user@example.com',
    },
    { name: 'name', type: 'text', label: 'Name (optional)', placeholder: 'John Doe' },
    {
      name: 'role',
      type: 'select',
      label: 'Role',
      required: true,
      options: [
        { value: 'member', label: 'Member' },
        { value: 'manager', label: 'Manager' },
        { value: 'admin', label: 'Admin' },
      ],
    },
  ],
};
let inviteFormRef: { validateAll: () => boolean } | null = $state(null);

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let users = $state<any[]>([]);
let loading = $state(true);
let currentPage = $state(1);
let total = $state(0);
const LIMIT = 20;
let showInviteModal = $state(false);
let inviting = $state(false);
let search = $state('');

// Bulk-select state (L29). Set keeps O(1) membership checks; reset when
// the page changes or the user list reloads.
let selectedIds = $state<Set<string>>(new SvelteSet());
const selectedCount = $derived(selectedIds.size);
const allOnPageSelected = $derived(users.length > 0 && users.every((u) => selectedIds.has(u.id)));
const someOnPageSelected = $derived(selectedCount > 0 && !allOnPageSelected);
function toggleSelect(id: string) {
  const next = new SvelteSet(selectedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds = next;
}
function toggleSelectAllOnPage() {
  const next = new SvelteSet(selectedIds);
  if (allOnPageSelected) {
    for (const u of users) next.delete(u.id);
  } else {
    for (const u of users) next.add(u.id);
  }
  selectedIds = next;
}
function clearSelection() {
  selectedIds = new SvelteSet();
}

const filteredUsers = $derived(
  search.trim()
    ? users.filter(
        (u) =>
          (u.name ?? '').toLowerCase().includes(search.toLowerCase()) ||
          (u.email ?? '').toLowerCase().includes(search.toLowerCase()),
      )
    : users,
);

let inviteForm = $state({ email: '', name: '', role: 'member' });
let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });

onMount(async () => {
  await loadUsers();
});

async function loadUsers() {
  loading = true;
  try {
    const res = await usersApi.list({ limit: LIMIT, offset: (currentPage - 1) * LIMIT });
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    users = Array.isArray(res) ? res : ((res as any).users ?? res);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    total = (res as any).total ?? users.length;
  } finally {
    loading = false;
  }
}

async function inviteUser() {
  if (inviteFormRef && !inviteFormRef.validateAll()) return;
  if (!inviteForm.email) return;
  inviting = true;
  try {
    await usersApi.invite(inviteForm);
    showInviteModal = false;
    inviteForm = { email: '', name: '', role: 'member' };
    await loadUsers();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to invite user');
  } finally {
    inviting = false;
  }
}

async function renameUser(id: string, name: string) {
  await usersApi.update(id, { name });
  // Optimistic local update — keep the table reactive without a full reload.
  users = users.map((u) => (u.id === id ? { ...u, name } : u));
}

async function deleteUser(id: string, email: string) {
  confirmState = {
    open: true,
    title: 'Delete User',
    message: `Delete user ${email}?`,
    confirmLabel: 'Delete',
    onconfirm: async () => {
      confirmState.open = false;
      await usersApi.delete(id);
      await loadUsers();
    },
  };
}

async function deleteSelected() {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;
  confirmState = {
    open: true,
    title: `Delete ${ids.length} user${ids.length === 1 ? '' : 's'}`,
    message: `Permanently remove ${ids.length} selected user${ids.length === 1 ? '' : 's'}? This cannot be undone.`,
    confirmLabel: `Delete ${ids.length}`,
    onconfirm: async () => {
      confirmState.open = false;
      const results = await Promise.allSettled(ids.map((id) => usersApi.delete(id)));
      const failures = results.filter((r) => r.status === 'rejected').length;
      if (failures > 0) {
        toast.error(
          `Removed ${ids.length - failures}/${ids.length} — ${failures} failed (check audit log).`,
        );
      } else {
        toast.success(`Removed ${ids.length} user${ids.length === 1 ? '' : 's'}.`);
      }
      clearSelection();
      await loadUsers();
    },
  };
}

function formatDate(d?: string) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString();
}

function formatRelative(dateStr?: string): string {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Role badges represent levels of access, NOT severity. Avoid badge-error
// (looks like a problem) and badge-warning (looks like attention needed).
// god → secondary (distinct, signals superuser-level access).
// admin → primary (the main authority role for normal operators).
// manager → info (mid-level).
// member → ghost (default, low-key — they're just regular users).
const ROLE_BADGES: Record<string, string> = {
  god: 'badge-secondary',
  admin: 'badge-primary',
  manager: 'badge-info',
  member: 'badge-ghost',
};

function roleColor(role: string) {
  return ROLE_BADGES[role] ?? 'badge-ghost';
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function confirmDelete(user: any) {
  deleteUser(user.id, user.email);
}
</script>

<CrudListPage
  title="Users"
  subtitle="Manage team members and access"
  count={users.length}
  {loading}
  search={search}
  onSearchChange={(v) => (search = v)}
  searchPlaceholder="Search users..."
  searchThreshold={0}
  actionLabel="Invite User"
  actionIcon={UserPlus}
  onAction={() => (showInviteModal = true)}
  empty={{
    illustration: 'list',
    illustrationColor: 'text-primary',
    title: 'Bring your team in',
    description: 'Invite teammates with the right role and they\'ll get an email to set up their account.',
    actionLabel: 'Invite user',
    onAction: () => (showInviteModal = true),
  }}
>
  {#snippet headerExtras()}
    {#if selectedCount > 0}
      <div role="region" aria-label="Bulk actions" class="card bg-primary/5 border border-primary/30">
        <div class="card-body p-3 flex flex-row items-center gap-3">
          <span class="text-sm">
            <strong>{selectedCount}</strong> selected
          </span>
          <button class="btn btn-ghost btn-sm" onclick={clearSelection} aria-label="Clear selection">Clear</button>
          <div class="grow"></div>
          <button class="btn btn-error btn-sm gap-2" onclick={deleteSelected} aria-label="Delete selected users">
            <Trash2 size={14} /> Delete {selectedCount}
          </button>
        </div>
      </div>
    {/if}
  {/snippet}

  {#snippet list()}
   <div class="card bg-base-200">
     <div class="overflow-x-auto">
       <table class="table table-sm w-full">
         <thead>
           <tr>
             <th class="w-8">
               <input
                 type="checkbox"
                 class="checkbox checkbox-xs"
                 checked={allOnPageSelected}
                 indeterminate={someOnPageSelected}
                 onchange={toggleSelectAllOnPage}
                 aria-label="Select all users on this page"
               />
             </th>
             <th>User</th><th>Role</th><th>Joined</th><th>Last active</th><th class="text-right">Actions</th>
           </tr>
         </thead>
         <tbody>
           {#each filteredUsers as user}
             <tr class="hover group {selectedIds.has(user.id) ? 'bg-primary/5' : ''}">
               <td>
                 <input
                   type="checkbox"
                   class="checkbox checkbox-xs"
                   checked={selectedIds.has(user.id)}
                   onchange={() => toggleSelect(user.id)}
                   aria-label="Select {user.email}"
                 />
               </td>
               <td>
                 <div class="flex items-center gap-2.5">
                   <div class="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-semibold">
                     {user.name?.charAt(0)?.toUpperCase() ?? '?'}
                   </div>
                   <div class="min-w-0">
                     <div class="text-sm font-medium">
                       <InlineEdit
                         value={user.name ?? ''}
                         label="Edit user name"
                         placeholder="—"
                         onsave={(next) => renameUser(user.id, next)}
                       />
                     </div>
                     <div class="text-xs text-base-content/40">{user.email}</div>
                   </div>
                 </div>
               </td>
               <td>
                 <span class="badge badge-sm {roleColor(user.role)}">
                   {user.role || 'member'}
                 </span>
               </td>
               <td class="text-xs text-base-content/50">{formatDate(user.created_at)}</td>
               <td class="text-xs text-base-content/50">{formatRelative(user.updated_at)}</td>
               <td class="text-right">
                 <div class="flex gap-0.5 justify-end opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                   <a
                     href="{base}/permissions?user={user.id}"
                     class="btn btn-ghost btn-xs"
                     title="Permissions for {user.email}"
                     aria-label="Manage permissions for {user.email}"
                   >
                     <Shield size={13} />
                   </a>
                   <button
                     class="btn btn-ghost btn-xs text-error"
                     onclick={() => confirmDelete(user)}
                     title="Remove user"
                     aria-label="Remove {user.email}"
                   >
                     <Trash2 size={13} />
                   </button>
                 </div>
               </td>
             </tr>
           {/each}
         </tbody>
       </table>
     </div>
   </div>
  {/snippet}

  {#snippet pagination()}
    <Pagination {total} page={currentPage} limit={LIMIT} onchange={(p) => { currentPage = p; loadUsers(); }} />
  {/snippet}
</CrudListPage>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') showInviteModal = false; }} />

{#if showInviteModal}
 <dialog class="modal modal-open">
 <div class="modal-box max-w-md">
 <h3 class="font-bold text-lg mb-4">Invite User</h3>

 <SchemaForm
   bind:this={inviteFormRef}
   formId="core:user-invite"
   schema={inviteSchema}
   bind:values={inviteForm}
   ctx={{ user: auth.user, mode: 'create' }}
 />

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showInviteModal = false)}>Cancel</button>
 <button class="btn btn-primary" onclick={inviteUser} disabled={inviting}>
 {#if inviting}<span class="loading loading-spinner loading-sm"></span>{/if}
 Send Invite
 </button>
 </div>
 </div>
 <button class="modal-backdrop" aria-label="Close" onclick={() => (showInviteModal = false)}></button>
 </dialog>
{/if}

<ConfirmModal
 open={confirmState.open}
 title={confirmState.title}
 message={confirmState.message}
 confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
 onconfirm={confirmState.onconfirm}
 oncancel={() => (confirmState.open = false)}
/>
