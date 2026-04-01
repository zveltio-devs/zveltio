<script lang="ts">
 import { onMount } from 'svelte';
 import { usersApi } from '$lib/api.js';
 import { UserPlus, Users } from '@lucide/svelte';
 import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
 import Pagination from '$lib/components/common/Pagination.svelte';
 import { toast } from '$lib/stores/toast.svelte.js';
 import PageHeader from '$lib/components/common/PageHeader.svelte';
 import EmptyState from '$lib/components/common/EmptyState.svelte';
 import SearchBar from '$lib/components/common/SearchBar.svelte';

 let users = $state<any[]>([]);
 let loading = $state(true);
 let currentPage = $state(1);
 let total = $state(0);
 const LIMIT = 20;
 let showInviteModal = $state(false);
 let inviting = $state(false);
 let search = $state('');

 const filteredUsers = $derived(
   search.trim()
     ? users.filter(u =>
         (u.name ?? '').toLowerCase().includes(search.toLowerCase()) ||
         (u.email ?? '').toLowerCase().includes(search.toLowerCase()),
       )
     : users,
 );

 let inviteForm = $state({ email: '', name: '', role: 'member' });
 let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

 onMount(async () => {
 await loadUsers();
 });

 async function loadUsers() {
 loading = true;
 try {
 const res = await usersApi.list({ limit: LIMIT, offset: (currentPage - 1) * LIMIT });
 users = Array.isArray(res) ? res : (res as any).users ?? res;
 total = (res as any).total ?? users.length;
 } finally {
 loading = false;
 }
 }

 async function inviteUser() {
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

 const ROLE_BADGES: Record<string, string> = {
 god: 'badge-error',
 admin: 'badge-warning',
 member: 'badge-primary',
 };

 function roleColor(role: string) {
 return ROLE_BADGES[role] ?? 'badge-ghost';
 }

 function openEdit(user: any) {
 toast.info('Role management coming soon');
 }

 function confirmDelete(user: any) {
 deleteUser(user.id, user.email);
 }
</script>

<div class="space-y-4">
 <PageHeader title="Users" subtitle="Manage team members and access" count={users.length}>
   <button class="btn btn-primary btn-sm gap-2" onclick={() => (showInviteModal = true)}>
     <UserPlus size={16} />
     Invite User
   </button>
 </PageHeader>

 <SearchBar value={search} onchange={(v: string) => search = v} placeholder="Search users..." />

 {#if loading}
   <div class="flex justify-center py-12">
     <span class="loading loading-spinner loading-lg"></span>
   </div>
 {:else if users.length === 0}
   <EmptyState
     icon={Users}
     title="No users found"
     description="Invite team members to collaborate in Zveltio Studio."
     actionLabel="Invite User"
     onaction={() => (showInviteModal = true)}
   />
 {:else}
   <div class="card bg-base-200">
     <div class="overflow-x-auto">
       <table class="table table-sm w-full">
         <thead>
           <tr>
             <th>User</th><th>Role</th><th>Joined</th><th>Last active</th><th class="text-right">Actions</th>
           </tr>
         </thead>
         <tbody>
           {#each filteredUsers as user}
             <tr class="hover group">
               <td>
                 <div class="flex items-center gap-2.5">
                   <div class="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-semibold">
                     {user.name?.charAt(0)?.toUpperCase() ?? '?'}
                   </div>
                   <div>
                     <div class="text-sm font-medium">{user.name || '—'}</div>
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
                 <button class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100" onclick={() => openEdit(user)}>Edit</button>
                 <button class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100" onclick={() => confirmDelete(user)}>Delete</button>
               </td>
             </tr>
           {/each}
         </tbody>
       </table>
     </div>
   </div>
 {/if}
 <Pagination {total} page={currentPage} limit={LIMIT} onchange={(p) => { currentPage = p; loadUsers(); }} />
</div>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') showInviteModal = false; }} />

{#if showInviteModal}
 <dialog class="modal modal-open">
 <div class="modal-box max-w-md">
 <h3 class="font-bold text-lg mb-4">Invite User</h3>

 <div class="space-y-3">
 <div class="form-control">
 <label class="label" for="invite-email"><span class="label-text">Email</span></label>
 <input
 id="invite-email"
 type="email"
 bind:value={inviteForm.email}
 placeholder="user@example.com"
 class="input"
 />
 </div>
 <div class="form-control">
 <label class="label" for="invite-name"><span class="label-text">Name (optional)</span></label>
 <input
 id="invite-name"
 type="text"
 bind:value={inviteForm.name}
 placeholder="John Doe"
 class="input"
 />
 </div>
 <div class="form-control">
 <label class="label" for="invite-role"><span class="label-text">Role</span></label>
 <select id="invite-role" bind:value={inviteForm.role} class="select">
 <option value="member">Member</option>
 <option value="manager">Manager</option>
 <option value="admin">Admin</option>
 </select>
 </div>
 </div>

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
