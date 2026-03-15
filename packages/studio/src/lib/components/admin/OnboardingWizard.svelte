<script lang="ts">
 import { goto } from '$app/navigation';
 import { base } from '$app/paths';
 import { api } from '$lib/api.js';
import { Database, Settings, Sparkles, CheckCircle, ArrowRight, X } from '@lucide/svelte';

 let { onComplete }: { onComplete: () => void } = $props();

 let step = $state(1);
 let saving = $state(false);

 let companyName = $state('');
 let primaryColor = $state('#570df8');

 let collectionName = $state('');
 let collectionDisplay = $state('');
 let skipCollection = $state(false);
 let collectionCreated = $state(false);

 async function saveBranding() {
 if (!companyName.trim()) { step = 2; return; }
 saving = true;
 try {
 await api.patch('/api/settings/bulk', {
 branding: { company_name: companyName, primary_color: primaryColor }
 });
 } catch { /* non-critical */ }
 saving = false;
 step = 2;
 }

 async function createFirstCollection() {
 if (skipCollection) { step = 3; return; }
 if (!collectionName.trim()) return;
 saving = true;
 try {
 await api.post('/api/collections', {
 name: collectionName.toLowerCase().replace(/\s+/g, '_'),
 displayName: collectionDisplay || collectionName,
 icon: 'Database',
 });
 collectionCreated = true;
 step = 3;
 } catch (e) {
 alert('Failed to create collection: ' + (e instanceof Error ? e.message : 'Unknown error'));
 } finally {
 saving = false;
 }
 }

 async function completeOnboarding() {
 saving = true;
 try {
 await api.post('/api/admin/onboarding/complete');
 } catch { /* non-critical */ }
 saving = false;
 onComplete();
 }

 const steps = [
 { n: 1, label: 'Branding', icon: Settings },
 { n: 2, label: 'First Collection', icon: Database },
 { n: 3, label: 'Done', icon: CheckCircle },
 ];
</script>

<div class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
 <div class="bg-base-100 rounded-2xl shadow-2xl w-full max-w-lg">
 <div class="p-6 border-b border-base-200">
 <div class="flex items-center justify-between mb-4">
 <h2 class="text-xl font-bold">Welcome to Zveltio!</h2>
 <button class="btn btn-ghost btn-sm btn-square" onclick={completeOnboarding}><X size={16} /></button>
 </div>
 <div class="flex items-center gap-2">
 {#each steps as s}
 <div class="flex items-center gap-2">
 <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold
 {step === s.n ? 'bg-primary text-primary-content' :
 step > s.n ? 'bg-success text-success-content' : 'bg-base-300'}">
 {step > s.n ? '✓' : s.n}
 </div>
 <span class="text-xs {step === s.n ? 'font-semibold' : 'opacity-40'}">{s.label}</span>
 {#if s.n < steps.length}<div class="w-8 h-px bg-base-300"></div>{/if}
 </div>
 {/each}
 </div>
 </div>

 <div class="p-6">
 {#if step === 1}
 <h3 class="font-semibold mb-1">Set up your branding</h3>
 <p class="text-sm opacity-60 mb-4">Give your platform a name and choose a color.</p>

 <div class="form-control mb-3">
 <label class="label" for="company-name"><span class="label-text">Organization / Company Name</span></label>
 <input id="company-name" type="text" class="input" placeholder="e.g., My Organization" bind:value={companyName} />
 </div>

 <div class="form-control mb-6">
 <label class="label" for="primary-color"><span class="label-text">Primary Color</span></label>
 <div class="flex items-center gap-3">
 <input id="primary-color" type="color" class="w-12 h-10 rounded border border-base-300 cursor-pointer" bind:value={primaryColor} />
 <input type="text" class="input input-sm flex-1" bind:value={primaryColor} />
 </div>
 </div>

 <button class="btn btn-primary w-full gap-2" onclick={saveBranding} disabled={saving}>
 {saving ? 'Saving...' : 'Continue'}<ArrowRight size={16} />
 </button>
 <button class="btn btn-ghost btn-sm w-full mt-2" onclick={() => (step = 2)}>Skip for now</button>

 {:else if step === 2}
 <h3 class="font-semibold mb-1">Create your first collection</h3>
 <p class="text-sm opacity-60 mb-4">Collections are database tables — for articles, products, employees, etc.</p>

 <label class="cursor-pointer flex items-center gap-3 mb-4">
 <input type="checkbox" class="checkbox checkbox-sm" bind:checked={skipCollection} />
 <span class="text-sm">I'll create collections later</span>
 </label>

 {#if !skipCollection}
 <div class="form-control mb-3">
 <label class="label" for="coll-name"><span class="label-text">Collection Name (lowercase, no spaces)</span></label>
 <input id="coll-name" type="text" class="input" placeholder="e.g., articles, employees"
 bind:value={collectionName}
 oninput={(e) => {
 collectionName = e.currentTarget.value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
 if (!collectionDisplay) collectionDisplay = collectionName.replace(/_/g, ' ');
 }} />
 </div>
 <div class="form-control mb-6">
 <label class="label" for="coll-display"><span class="label-text">Display Name</span></label>
 <input id="coll-display" type="text" class="input" placeholder="e.g., Articles, Employees" bind:value={collectionDisplay} />
 </div>
 {/if}

 <button class="btn btn-primary w-full gap-2" onclick={createFirstCollection}
 disabled={saving || (!skipCollection && !collectionName.trim())}>
 {saving ? 'Creating...' : skipCollection ? 'Skip' : 'Create Collection'}<ArrowRight size={16} />
 </button>

 {:else if step === 3}
 <div class="text-center py-4">
 <CheckCircle size={48} class="mx-auto mb-4 text-success" />
 <h3 class="font-bold text-lg mb-2">You're all set!</h3>
 <p class="text-sm opacity-60 mb-6">
 {collectionCreated
 ? `Your collection "${collectionDisplay || collectionName}" has been created.`
 : 'Your platform is ready.'}
 <br />Start by adding fields to your collections, then manage your data from Data Studio.
 </p>
 <div class="flex flex-col gap-2">
 <button class="btn btn-primary gap-2" onclick={completeOnboarding}>
 <Sparkles size={16} /> Go to Dashboard
 </button>
 {#if collectionCreated}
 <button class="btn btn-outline btn-sm gap-2"
 onclick={() => { completeOnboarding(); goto(`${base}/collections`); }}>
 <Database size={14} /> Add fields to my collection
 </button>
 {/if}
 </div>
 </div>
 {/if}
 </div>
 </div>
</div>
