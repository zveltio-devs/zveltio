<script lang="ts">
 // Place once in admin +layout.svelte: <ToastContainer />
 // Trigger from anywhere: import { toast } from '$lib/stores/toast.svelte'; toast.success('Saved!');
 import { toast } from '$lib/stores/toast.svelte.js';
import { X } from '@lucide/svelte';

 const alertClass: Record<string, string> = {
 success: 'alert-success',
 error: 'alert-error',
 warning: 'alert-warning',
 info: 'alert-info',
 };

 const alertIcon: Record<string, string> = {
 success: '✓', error: '✕', warning: '⚠', info: 'ℹ',
 };
</script>

<div class="toast toast-end toast-bottom z-[9999]">
 {#each toast.items as t (t.id)}
 <div class="alert {alertClass[t.type]} shadow-lg max-w-sm animate-slide-in">
 <span class="text-lg font-bold">{alertIcon[t.type]}</span>
 <span class="text-sm">{t.message}</span>
 <button class="btn btn-ghost btn-xs" onclick={() => toast.remove(t.id)}>
 <X size={14} />
 </button>
 </div>
 {/each}
</div>

<style>
 @keyframes slide-in {
 from { transform: translateX(100%); opacity: 0; }
 to { transform: translateX(0); opacity: 1; }
 }
 :global(.animate-slide-in) { animation: slide-in 0.3s ease-out; }
</style>
