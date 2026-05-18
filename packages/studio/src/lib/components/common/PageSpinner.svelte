<script lang="ts">
  /**
   * Page-level loading spinner.
   *
   * Centered Lucide spinner with screen-reader label. Used while a page
   * is fetching its initial data — matches the Lucide-only iconography
   * convention. For inline-button spinners (Save / Delete buttons that
   * disable themselves while pending), keep using DaisyUI's
   * `<span class="loading loading-spinner loading-sm">` — it sits flush
   * with button text more reliably than the Lucide icon.
   */
  import { LoaderCircle } from '@lucide/svelte';

  interface Props {
    /** Spinner icon size in px. Default 28. */
    size?: number;
    /** Vertical padding (py-N). Default `12`. */
    py?: 6 | 8 | 12 | 16 | 20;
    /** Screen-reader label. Default "Loading…". */
    label?: string;
  }

  // Tailwind needs static class names — map at runtime.
  const PY_CLASS = {
    6: 'py-6',
    8: 'py-8',
    12: 'py-12',
    16: 'py-16',
    20: 'py-20',
  } as const;

  let { size = 28, py = 12, label = 'Loading…' }: Props = $props();
</script>

<div class="flex justify-center {PY_CLASS[py]}" role="status" aria-label={label}>
  <LoaderCircle {size} class="animate-spin text-primary" />
  <span class="sr-only">{label}</span>
</div>
