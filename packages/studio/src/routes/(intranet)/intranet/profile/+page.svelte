<script lang="ts">
  import { onMount } from 'svelte';
  import { auth } from '$lib/auth.svelte.js';
  import { api } from '$lib/api.js';
  import { User as UserIcon, Save, Lock, Mail, Calendar } from '@lucide/svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  let name = $state('');
  let email = $state('');
  let saving = $state(false);
  let pwOld = $state('');
  let pwNew = $state('');
  let pwBusy = $state(false);

  onMount(async () => {
    await auth.init();
    name = auth.user?.name ?? '';
    email = auth.user?.email ?? '';
  });

  async function saveProfile() {
    if (!name.trim()) { toast.error('Name is required'); return; }
    saving = true;
    try {
      // Better-Auth update-user endpoint
      const res = await fetch('/api/auth/update-user', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Profile updated');
      await auth.init();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to update profile');
    } finally {
      saving = false;
    }
  }

  async function changePassword() {
    if (pwNew.length < 8) { toast.error('New password must be at least 8 characters'); return; }
    pwBusy = true;
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: pwOld, newPassword: pwNew }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message ?? `HTTP ${res.status}`);
      }
      toast.success('Password changed');
      pwOld = '';
      pwNew = '';
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to change password');
    } finally {
      pwBusy = false;
    }
  }
</script>

<div class="space-y-6 max-w-2xl">

  <div>
    <h1 class="text-xl font-semibold flex items-center gap-2">
      <UserIcon size={18} class="text-primary" /> My Profile
    </h1>
    <p class="text-sm text-base-content/50 mt-0.5">Manage your account info and password.</p>
  </div>

  <!-- Header card -->
  <div class="card bg-base-200 border border-base-300">
    <div class="card-body p-5 flex-row items-center gap-4">
      <div class="w-16 h-16 rounded-full bg-primary text-primary-content flex items-center justify-center text-2xl font-bold shrink-0">
        {auth.user?.name?.charAt(0).toUpperCase() ?? 'U'}
      </div>
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-base">{auth.user?.name ?? 'User'}</p>
        <p class="text-sm text-base-content/60 flex items-center gap-1.5"><Mail size={12} /> {auth.user?.email ?? '—'}</p>
        {#if auth.user?.createdAt}
          <p class="text-xs text-base-content/40 mt-1 flex items-center gap-1.5">
            <Calendar size={11} /> Joined {new Date(auth.user.createdAt).toLocaleDateString()}
          </p>
        {/if}
      </div>
    </div>
  </div>

  <!-- Edit profile -->
  <div class="card bg-base-200 border border-base-300">
    <div class="card-body p-5 gap-4">
      <h2 class="font-semibold text-sm">Account info</h2>

      <div class="form-control">
        <label class="label py-1" for="profile-name"><span class="label-text text-xs">Display name</span></label>
        <input id="profile-name" type="text" bind:value={name} class="input input-sm input-bordered" />
      </div>

      <div class="form-control">
        <label class="label py-1" for="profile-email"><span class="label-text text-xs">Email</span></label>
        <input id="profile-email" type="email" value={email} disabled class="input input-sm input-bordered opacity-60" />
        <span class="label-text-alt text-xs text-base-content/40 mt-1">Email changes are managed by an administrator.</span>
      </div>

      <button class="btn btn-primary btn-sm w-fit gap-1.5" onclick={saveProfile} disabled={saving}>
        {#if saving}<span class="loading loading-spinner loading-xs"></span>{:else}<Save size={13} />{/if}
        Save changes
      </button>
    </div>
  </div>

  <!-- Change password -->
  <div class="card bg-base-200 border border-base-300">
    <div class="card-body p-5 gap-4">
      <h2 class="font-semibold text-sm flex items-center gap-2">
        <Lock size={14} class="text-primary" /> Change password
      </h2>

      <div class="form-control">
        <label class="label py-1" for="pw-old"><span class="label-text text-xs">Current password</span></label>
        <input id="pw-old" type="password" bind:value={pwOld} class="input input-sm input-bordered" autocomplete="current-password" />
      </div>

      <div class="form-control">
        <label class="label py-1" for="pw-new"><span class="label-text text-xs">New password</span></label>
        <input id="pw-new" type="password" bind:value={pwNew} class="input input-sm input-bordered" autocomplete="new-password" minlength="8" />
        <span class="label-text-alt text-xs text-base-content/40 mt-1">At least 8 characters.</span>
      </div>

      <button class="btn btn-primary btn-sm w-fit gap-1.5" onclick={changePassword} disabled={pwBusy || !pwOld || !pwNew}>
        {#if pwBusy}<span class="loading loading-spinner loading-xs"></span>{:else}<Lock size={13} />{/if}
        Update password
      </button>
    </div>
  </div>

</div>
