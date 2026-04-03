<script lang="ts">
  let {
    steps = [],
    onComplete,
    children
  }: {
    steps?: Array<{
      id: string;
      title: string;
      description?: string;
    }>;
    onComplete?: () => void;
    children?: any;
  } = $props();

  let currentStep = $state(0);
  let completedSteps = $state<Set<string>>(new Set());
  let wizardOpen = $state(true);

  const progress = $derived(steps.length > 1 ? currentStep / (steps.length - 1) * 100 : 100);

  function nextStep() {
    completedSteps.add(steps[currentStep].id);
    if (currentStep < steps.length - 1) {
      currentStep++;
    } else {
      onComplete?.();
    }
  }

  function prevStep() {
    if (currentStep > 0) {
      currentStep--;
    }
  }

  function close() {
    wizardOpen = false;
  }

  function completeWizard() {
    onComplete?.();
    close();
  }

  function getStepStatus(index: number) {
    if (index < currentStep) return 'completed';
    if (index === currentStep) return 'active';
    return 'pending';
  }
</script>

{#if wizardOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <div class="card w-full max-w-2xl bg-base-100 shadow-2xl">
      <!-- Progress Bar -->
      <div class="progress h-2 bg-base-300 rounded-full overflow-hidden m-6">
        <div 
          class="progress-bar bg-primary transition-all duration-500 ease-out"
          style="width: {progress}%"
        ></div>
      </div>

      <!-- Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-base-300 dark:border-base-700">
        <h2 class="text-xl font-bold">{steps[currentStep]?.title}</h2>
        <button 
          class="btn btn-ghost btn-xs btn-circle" 
          onclick="{close}"
          aria-label="Close wizard"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <!-- Content -->
      <div class="p-6">
        <p class="text-base-content/70 mb-6">{steps[currentStep]?.description}</p>
        
        <div class="min-h-50">
          {@render children()}
        </div>

        <!-- Step indicators -->
        <div class="flex gap-2 mt-6 mb-6 overflow-x-auto">
          {#each steps as step, index}
            <div class="flex items-center gap-2 shrink-0">
              <div 
                class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium
                       {getStepStatus(index) === 'completed' 
                         ? 'bg-success text-success-content' 
                         : getStepStatus(index) === 'active'
                           ? 'bg-primary text-primary-content'
                           : 'bg-base-300 text-base-content/50'}"
              >
                {#if getStepStatus(index) === 'completed'}
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                {:else}
                  {index + 1}
                {/if}
              </div>
              <span class="text-xs font-medium hidden sm:block">{step.title}</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- Footer -->
      <div class="flex items-center justify-end gap-3 px-6 py-4 border-t border-base-300 dark:border-base-700">
        <button 
          class="btn {currentStep === 0 ? 'btn-disabled' : ''}"
          onclick="{prevStep}"
          disabled="{currentStep === 0}"
        >
          Back
        </button>
        <button 
          class="btn btn-primary"
          onclick="{currentStep === steps.length - 1 ? completeWizard : nextStep}"
        >
          {currentStep === steps.length - 1 ? 'Finish Setup' : 'Next'}
        </button>
      </div>
    </div>
  </div>
{/if}