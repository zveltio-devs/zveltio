<script lang="ts">
  import { onMount } from 'svelte';
  import { auth } from '$lib/auth.svelte.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import PasskeysSection from '$lib/components/common/PasskeysSection.svelte';
  import Slot from '$lib/components/common/Slot.svelte';
  import { User as UserIcon, Save } from '@lucide/svelte';

  let name = $state('');
  let email = $state('');
  let saving = $state(false);

  onMount(async () => {
    await auth.init();
    name = auth.user?.name ?? '';
    email = auth.user?.email ?? '';
  });

  async function saveProfile(): Promise<void> {
    if (!name.trim()) { toast.error('Name is required'); return; }
    saving = true;
    try {
      const res = await fetch('/api/auth/update-user', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Profile updated');
      await auth.init();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update profile');
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-6 max-w-2xl">
  <PageHeader title="Account" subtitle="Manage your profile and security settings" />

  <!-- Profile -->
  <section class="card bg-base-200">
    <div class="card-body">
      <div class="flex items-start gap-3">
        <div class="p-2 bg-primary/10 rounded-lg shrink-0">
          <UserIcon size={20} class="text-primary" />
        </div>
        <div class="flex-1">
          <h2 class="card-title text-base">Profile</h2>
          <p class="text-sm text-base-content/60 mt-0.5">Basic identity. Email is read-only.</p>
        </div>
      </div>

      <div class="space-y-3 mt-4">
        <div class="form-control">
          <label class="label" for="acct-name"><span class="label-text">Name</span></label>
          <input
            id="acct-name"
            type="text"
            class="input input-bordered w-full"
            bind:value={name}
            placeholder="Your name"
          />
        </div>
        <div class="form-control">
          <label class="label" for="acct-email"><span class="label-text">Email</span></label>
          <input
            id="acct-email"
            type="email"
            class="input input-bordered w-full"
            value={email}
            disabled
          />
        </div>
        <div class="flex justify-end">
          <button class="btn btn-primary btn-sm gap-1.5" onclick={saveProfile} disabled={saving}>
            <Save size={14} />
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </div>
    </div>
  </section>

  <!-- Passkeys -->
  <PasskeysSection />

  <!-- S3-03: slot for extensions to add account-page sections (e.g.
       API keys, audit log, organization membership). Renders below the
       built-in sections. ctx exposes the current user. -->
  <Slot name="account.sections" ctx={{ user: auth.user }} />
</div>
