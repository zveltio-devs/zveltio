<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { auth } from '$lib/auth.svelte.js';
  import { User, Building2, Plus, AlertCircle, CheckCircle, Edit2, Save } from '@lucide/svelte';

  let loading = $state(true);
  let me = $state<any>(null);
  let savingProfile = $state(false);
  let savingOperator = $state(false);
  let profileError = $state('');
  let profileSuccess = $state(false);
  let operatorError = $state('');
  let operatorSuccess = $state(false);
  let showOperatorForm = $state(false);

  let profileForm = $state({ name: '', email: '' });
  let operatorForm = $state({
    name: '', fiscal_code: '', legal_form: '', address: '', county: '',
  });

  const LEGAL_FORMS = ['SRL', 'SA', 'SNC', 'SCS', 'RA', 'SN', 'PFA', 'II', 'IF', 'Altele'];

  onMount(async () => {
    try {
      const res = await api.get<any>('/api/portal-client/me');
      me = res;
      profileForm = { name: res.user?.name ?? '', email: res.user?.email ?? '' };
      if (res.operators?.length) {
        const op = res.operators[0];
        operatorForm = {
          name: op.name ?? '',
          fiscal_code: op.fiscal_code ?? '',
          legal_form: op.legal_form ?? '',
          address: op.address ?? '',
          county: op.county ?? '',
        };
      }
    } finally {
      loading = false;
    }
  });

  async function saveProfile() {
    if (!profileForm.name.trim()) { profileError = 'Numele este obligatoriu.'; return; }
    savingProfile = true; profileError = ''; profileSuccess = false;
    try {
      await api.patch('/api/me', { name: profileForm.name });
      profileSuccess = true;
      setTimeout(() => (profileSuccess = false), 3000);
    } catch (e: any) {
      profileError = e.message || 'Eroare.';
    } finally {
      savingProfile = false;
    }
  }

  async function registerOperator() {
    if (!operatorForm.fiscal_code.trim() || !operatorForm.name.trim()) {
      operatorError = 'CUI și denumirea sunt obligatorii.'; return;
    }
    savingOperator = true; operatorError = ''; operatorSuccess = false;
    try {
      await api.post('/api/portal-client/operators/register', operatorForm);
      operatorSuccess = true;
      showOperatorForm = false;
      const res = await api.get<any>('/api/portal-client/me');
      me = res;
      setTimeout(() => (operatorSuccess = false), 4000);
    } catch (e: any) {
      operatorError = e.message || 'Eroare.';
    } finally {
      savingOperator = false;
    }
  }
</script>

<div class="max-w-2xl space-y-6">
  <div>
    <h1 class="text-xl font-bold text-base-content">Profilul meu</h1>
    <p class="text-sm text-base-content/50 mt-0.5">Gestionează datele contului și ale firmei tale</p>
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-md text-primary"></span></div>
  {:else}
    <!-- ─── User profile ─── -->
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-5 gap-4">
        <h2 class="font-semibold text-sm flex items-center gap-2"><User size={15} /> Cont utilizator</h2>

        {#if profileError}
          <div class="alert alert-error text-sm py-2"><AlertCircle size={14} /><span>{profileError}</span></div>
        {/if}
        {#if profileSuccess}
          <div class="alert alert-success text-sm py-2"><CheckCircle size={14} /><span>Profil actualizat.</span></div>
        {/if}

        <!-- Avatar -->
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 rounded-full bg-primary text-primary-content flex items-center justify-center text-xl font-bold">
            {profileForm.name?.charAt(0)?.toUpperCase() || 'U'}
          </div>
          <div>
            <p class="font-semibold">{profileForm.name || 'Utilizator'}</p>
            <p class="text-xs text-base-content/50">{profileForm.email}</p>
          </div>
        </div>

        <div class="grid gap-4">
          <div class="form-control gap-1">
            <label class="label py-0"><span class="label-text text-xs font-medium">Nume complet</span></label>
            <input type="text" bind:value={profileForm.name} class="input input-sm" />
          </div>
          <div class="form-control gap-1">
            <label class="label py-0"><span class="label-text text-xs font-medium">Email</span></label>
            <input type="email" value={profileForm.email} class="input input-sm" disabled />
            <p class="text-[11px] text-base-content/40 mt-0.5">Emailul nu poate fi modificat din portal.</p>
          </div>
        </div>

        <div class="flex justify-end">
          <button class="btn btn-primary btn-sm gap-1.5" onclick={saveProfile} disabled={savingProfile}>
            {#if savingProfile}<span class="loading loading-spinner loading-xs"></span>
            {:else}<Save size={13} />{/if}
            Salvează
          </button>
        </div>
      </div>
    </div>

    <!-- ─── Operator section ─── -->
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-5 gap-4">
        <div class="flex items-center justify-between">
          <h2 class="font-semibold text-sm flex items-center gap-2"><Building2 size={15} /> Operator economic</h2>
          {#if !me?.operators?.length}
            <button class="btn btn-sm btn-outline btn-primary gap-1.5"
              onclick={() => { showOperatorForm = !showOperatorForm; operatorError = ''; }}>
              <Plus size={13} /> Înregistrează firma
            </button>
          {/if}
        </div>

        {#if operatorError}
          <div class="alert alert-error text-sm py-2"><AlertCircle size={14} /><span>{operatorError}</span></div>
        {/if}
        {#if operatorSuccess}
          <div class="alert alert-success text-sm py-2">
            <CheckCircle size={14} />
            <span>Firma a fost înregistrată. Contul tău va fi verificat de administrator.</span>
          </div>
        {/if}

        {#if me?.operators?.length}
          {@const op = me.operators[0]}
          <div class="flex items-start gap-4">
            <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Building2 size={18} class="text-primary" />
            </div>
            <div class="flex-1 min-w-0">
              <p class="font-semibold text-sm">{op.name}</p>
              <p class="text-xs text-base-content/50 mt-0.5">CUI: {op.fiscal_code}{op.legal_form ? ` · ${op.legal_form}` : ''}</p>
              {#if op.address}
                <p class="text-xs text-base-content/50">{op.address}{op.county ? `, ${op.county}` : ''}</p>
              {/if}
              <div class="mt-2">
                {#if op.is_verified}
                  <span class="badge badge-success badge-sm gap-1">
                    <CheckCircle size={11} /> Cont verificat
                  </span>
                {:else}
                  <span class="badge badge-warning badge-sm gap-1">
                    <AlertCircle size={11} /> În așteptare verificare
                  </span>
                {/if}
              </div>
            </div>
          </div>

          {#if !op.is_verified}
            <div class="alert bg-warning/10 border border-warning/20 text-sm">
              <AlertCircle size={15} class="text-warning" />
              <span class="text-base-content/70">
                Contul tău nu a fost verificat încă. Contactează instituția pentru confirmare.
              </span>
            </div>
          {/if}

        {:else if showOperatorForm}
          <div class="grid gap-4">
            <div class="grid sm:grid-cols-2 gap-4">
              <div class="form-control gap-1">
                <label class="label py-0"><span class="label-text text-xs font-medium">CUI (Cod Unic Înregistrare) *</span></label>
                <input type="text" bind:value={operatorForm.fiscal_code} placeholder="ex. RO12345678" class="input input-sm" />
              </div>
              <div class="form-control gap-1">
                <label class="label py-0"><span class="label-text text-xs font-medium">Formă juridică</span></label>
                <select class="select select-sm" bind:value={operatorForm.legal_form}>
                  <option value="">— Selectează —</option>
                  {#each LEGAL_FORMS as f}
                    <option value={f}>{f}</option>
                  {/each}
                </select>
              </div>
            </div>
            <div class="form-control gap-1">
              <label class="label py-0"><span class="label-text text-xs font-medium">Denumire firmă *</span></label>
              <input type="text" bind:value={operatorForm.name} placeholder="SC Exemplu SRL" class="input input-sm" />
            </div>
            <div class="grid sm:grid-cols-2 gap-4">
              <div class="form-control gap-1">
                <label class="label py-0"><span class="label-text text-xs font-medium">Adresă sediu social</span></label>
                <input type="text" bind:value={operatorForm.address} placeholder="Str. Exemplu nr. 1" class="input input-sm" />
              </div>
              <div class="form-control gap-1">
                <label class="label py-0"><span class="label-text text-xs font-medium">Județ</span></label>
                <input type="text" bind:value={operatorForm.county} placeholder="Cluj" class="input input-sm" />
              </div>
            </div>

            <div class="flex gap-2 justify-end">
              <button class="btn btn-ghost btn-sm" onclick={() => (showOperatorForm = false)}>Anulează</button>
              <button class="btn btn-primary btn-sm" onclick={registerOperator} disabled={savingOperator}>
                {#if savingOperator}<span class="loading loading-spinner loading-xs"></span>{/if}
                Înregistrează
              </button>
            </div>
          </div>
        {:else}
          <div class="py-4 text-center">
            <p class="text-sm text-base-content/50">Nu ești asociat cu niciun operator economic.</p>
            <p class="text-xs text-base-content/40 mt-1">Apasă „Înregistrează firma" pentru a-ți înscrie compania.</p>
          </div>
        {/if}
      </div>
    </div>

    <!-- ─── Account info ─── -->
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-5 gap-2">
        <h2 class="font-semibold text-sm mb-2">Informații cont</h2>
        <div class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <p class="text-xs text-base-content/40 font-medium uppercase tracking-wide">ID utilizator</p>
            <p class="text-xs font-mono text-base-content/60 mt-0.5 truncate">{auth.user?.id ?? '—'}</p>
          </div>
          <div>
            <p class="text-xs text-base-content/40 font-medium uppercase tracking-wide">Rol</p>
            <p class="text-sm mt-0.5">{auth.user?.role ?? 'client'}</p>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
