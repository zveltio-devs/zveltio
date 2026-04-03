<script lang="ts">
  import { onMount } from 'svelte';

  let {
    title,
    size = 'md',
    closeOnEscape = true,
    closeOnOutsideClick = true,
    children,
    footer
  }: {
    title?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
    closeOnEscape?: boolean;
    closeOnOutsideClick?: boolean;
    children?: any;
    footer?: any;
  } = $props();

  let isOpen = $state(false);
  let modalRef = $state<HTMLDivElement | null>(null);
  let isClosing = $state(false);
  let focusedIndex = $state(0);
  let focusableElements: HTMLElement[] = [];

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-5xl',
    '2xl': 'max-w-6xl'
  };

  // Close modal
  function close() {
    isClosing = true;
    setTimeout(() => {
      isOpen = false;
      isClosing = false;
    }, 200);
  }

  // Get focusable elements
  $effect(() => {
    if (isOpen && modalRef) {
      const elements = modalRef.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') as NodeListOf<HTMLElement>;
      focusableElements = Array.from(elements);
      focusedIndex = 0;
    }
  });

  // Handle keyboard navigation
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Tab') {
      if (focusableElements.length === 0) return;
      if (e.shiftKey) {
        if (focusedIndex <= 0) {
          e.preventDefault();
          focusedIndex = focusableElements.length - 1;
          focusableElements[focusedIndex]?.focus();
        } else {
          focusedIndex--;
          focusableElements[focusedIndex]?.focus();
        }
      } else {
        if (focusedIndex >= focusableElements.length - 1) {
          e.preventDefault();
          focusedIndex = 0;
          focusableElements[0]?.focus();
        } else {
          focusedIndex++;
          focusableElements[focusedIndex]?.focus();
        }
      }
    } else if (e.key === 'Escape' && closeOnEscape) {
      close();
    }
  }

  // Focus management
  onMount(() => {
    if (isOpen && modalRef) {
      const firstInput = modalRef.querySelector('input, button, [tabindex]:not([tabindex="-1"])');
      if (firstInput instanceof HTMLElement) {
        firstInput.focus();
      }
    }
    
    if (closeOnEscape) {
      window.addEventListener('keydown', handleKeydown);
    }
    
    return () => {
      window.removeEventListener('keydown', handleKeydown);
    };
  });

  // Expose open function to parent
  export function openModal() {
    isOpen = true;
    isClosing = false;
  }
</script>

{#if isOpen}
  <dialog
    class="modal"
    aria-modal="true"
    aria-labelledby="modal-title"
    onclick="{close}"
  >
    <div 
      class="modal-box {sizes[size]} p-0"
    >
      {#if title || closeOnOutsideClick}
        <div class="flex items-center justify-between p-4 border-b border-base-300 dark:border-base-700">
          <h3 id="modal-title" class="text-lg font-semibold">{title}</h3>
          <button 
            class="btn btn-ghost btn-xs btn-circle" 
            onclick="{close}"
            aria-label="Close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      {/if}
      
      <div class="p-4">
        {@render children()}
      </div>
      
      {#if footer}
        <div class="flex items-center justify-end gap-2 p-4 border-t border-base-300 dark:border-base-700 bg-base-100/50">
          {@render footer()}
        </div>
      {/if}
    </div>
    
    <form method="dialog" class="modal-backdrop">
      <dialog open="{isOpen}"></dialog>
    </form>
  </dialog>
{/if}