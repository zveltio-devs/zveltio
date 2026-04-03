<script lang="ts">
  let {
    toast
  }: {
    toast: {
      message: string;
      type: 'success' | 'info' | 'warning' | 'error';
      action?: { label: string; onClick: () => void };
    };
  } = $props();

  let isOpen = $state(true);
  let isExiting = $state(false);

  const types = {
    success: {
      bg: 'bg-success/10',
      border: 'border-success',
      text: 'text-success',
      icon: 'check-circle'
    },
    info: {
      bg: 'bg-primary/10',
      border: 'border-primary',
      text: 'text-primary',
      icon: 'info'
    },
    warning: {
      bg: 'bg-warning/10',
      border: 'border-warning',
      text: 'text-warning',
      icon: 'alert-circle'
    },
    error: {
      bg: 'bg-error/10',
      border: 'border-error',
      text: 'text-error',
      icon: 'alert-circle'
    }
  };

  const currentType = $derived(types[toast.type]);

  // Close toast
  function close() {
    isExiting = true;
    setTimeout(() => {
      isOpen = false;
      isExiting = false;
    }, 200);
  }
</script>

{#if isOpen}
  <div class="toast toast-end animate-in slide-in-from-bottom-5 fade-in duration-300">
    <div class="alert {currentType.bg} {currentType.border} shadow-lg">
      <div class="flex items-center gap-3">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 {currentType.text}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <h3 class="font-medium text-sm">{currentType.text}</h3>
          <p class="text-sm opacity-80">{toast.message}</p>
        </div>
      </div>
      
      {#if toast.action}
        <button 
          class="btn btn-xs btn-ghost" 
          onclick="{() => { toast.action?.onClick(); close(); }}"
        >
          {toast.action.label}
        </button>
      {/if}
      
      <button 
        class="btn btn-ghost btn-xs" 
        onclick="{close}"
        aria-label="Close notification"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </div>
{/if}