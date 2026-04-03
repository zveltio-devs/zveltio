<script lang="ts">
  import Toast from './Toast.svelte';

  let toasts = $state<{ id: number; message: string; type: 'success' | 'info' | 'warning' | 'error'; action?: { label: string; onClick: () => void } }[]>([]);

  function addToast(message: string, type: 'success' | 'info' | 'warning' | 'error' = 'info', action?: { label: string; onClick: () => void }) {
    const id = Date.now();
    toasts = [...toasts, { id, message, type, action }];
    setTimeout(() => removeToast(id), 4000);
    return id;
  }

  function removeToast(id: number) {
    toasts = toasts.filter(t => t.id !== id);
  }

  function success(message: string, action?: { label: string; onClick: () => void }) {
    return addToast(message, 'success', action);
  }

  function info(message: string) {
    return addToast(message, 'info');
  }

  function warning(message: string) {
    return addToast(message, 'warning');
  }

  function error(message: string) {
    return addToast(message, 'error');
  }

  export { success, info, warning, error };
</script>

<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-3">
  {#each toasts as toast}
    <Toast toast={toast} />
  {/each}
</div>