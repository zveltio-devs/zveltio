<script lang="ts">
 import { onMount } from 'svelte';
 import { usersApi } from '$lib/api.js';
 import { UserPlus, Trash2, Shield } from '@lucide/svelte';

 let users = $state<any[]>([]);
 let loading = $state(true);
 let showInviteModal = $state(false);
 let inviting = $state(false);

 let inviteForm = $state({ email: '', name: '', role: 'member' });

 onMount(async () => {
 await loadUsers();
 });

 async function loadUsers() {
 loading = true;
 try {
 users = await usersApi.list();
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
 alert(err instanceof Error ? err.message : 'Failed to invite user');
 } finally {
 inviting = false;
 }
 }

 async function deleteUser(id: string, email: string) {
 if (!confirm(`Delete user ${email}?`)) return;
 await usersApi.delete(id);
 await loadUsers();
 }

 function formatDate(d: string) {
 return new Date(d).toLocaleDateString();
 }

 function roleColor(role: string) {
 if (role === 'admin') return 'badge-error';
 if (role === 'manager') return 'badge-warning';
 return 'badge-ghost';
 }
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">Users</h1>
 <p class="text-base-content/60 text-sm mt-1">Manage platform users and roles</p>
 </div>
 <button class="btn btn-primary btn-sm gap-2" onclick={() => (showInviteModal = true)}>
 <UserPlus size={16} />
 Invite User
 </button>
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
 <th>Name</th>
 <th>Email</th>
 <th>Role</th>
 <th>Joined</th>
 <th></th>
 </tr>
 </thead>
 <tbody>
 {#each users as user}
 <tr>
 <td>
 <div class="flex items-center gap-3">
 <div class="avatar placeholder">
 <div class="bg-primary text-primary-content rounded-full w-8">
 <span class="text-xs">{(user.name || user.email)[0].toUpperCase()}</span>
 </div>
 </div>
 <span class="font-medium">{user.name || '—'}</span>
 </div>
 </td>
 <td class="font-mono text-sm">{user.email}</td>
 <td>
 <span class="badge badge-sm {roleColor(user.role)}">{user.role || 'member'}</span>
 </td>
 <td class="text-sm text-base-content/60">{formatDate(user.created_at)}</td>
 <td>
 <div class="flex gap-1">
 <button
 class="btn btn-ghost btn-xs"
 title="Manage permissions"
 onclick={() => alert('Role management coming soon')}
 >
 <Shield size={14} />
 </button>
 <button
 class="btn btn-ghost btn-xs text-error"
 onclick={() => deleteUser(user.id, user.email)}
 >
 <Trash2 size={14} />
 </button>
 </div>
 </td>
 </tr>
 {/each}
 </tbody>
 </table>
 </div>
 </div>
 {/if}
</div>

{#if showInviteModal}
 <dialog class="modal modal-open">
 <div class="modal-box">
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
