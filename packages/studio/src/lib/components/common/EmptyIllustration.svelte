<script lang="ts">
/**
 * Abstract geometric illustrations for empty states.
 *
 * Three variants, all 120×120, using `currentColor` so they pick up
 * `text-primary` / `text-secondary` / `text-base-content/40` from the
 * parent. Two opacity layers per illustration create depth.
 *
 * Why abstract instead of scenes: scenes (people, plants, etc.) age
 * fast and feel cute. Abstract geometry stays timeless and works in
 * both light + dark themes without rework.
 *
 * Variants:
 *   - `list`     — stacked rectangles (records, rows, items)
 *   - `table`    — grid (schema, structured data)
 *   - `cloud`    — soft cluster (network, integrations, external)
 *   - `target`   — concentric circles (goals, suggestions, AI)
 *   - `spark`    — chart bars (metrics, insights, activity)
 */

type Variant = 'list' | 'table' | 'cloud' | 'target' | 'spark';

interface Props {
  variant?: Variant;
  /** Tailwind text color class. Default `text-primary`. */
  color?: string;
  size?: number;
}

let { variant = 'list', color = 'text-primary', size = 120 }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 120 120"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  class={color}
  aria-hidden="true"
>
  <!-- Soft circular backdrop — gives all variants a unified silhouette -->
  <circle cx="60" cy="60" r="50" fill="currentColor" fill-opacity="0.06" />
  <circle cx="60" cy="60" r="36" fill="currentColor" fill-opacity="0.08" />

  {#if variant === 'list'}
    <rect x="30" y="36" width="60" height="8" rx="3" fill="currentColor" fill-opacity="0.35" />
    <rect x="30" y="52" width="48" height="6" rx="2" fill="currentColor" fill-opacity="0.20" />
    <rect x="30" y="66" width="60" height="8" rx="3" fill="currentColor" fill-opacity="0.35" />
    <rect x="30" y="82" width="40" height="6" rx="2" fill="currentColor" fill-opacity="0.20" />

  {:else if variant === 'table'}
    <rect x="28" y="36" width="64" height="48" rx="6" fill="currentColor" fill-opacity="0.10" />
    <rect x="32" y="40" width="56" height="6" rx="2" fill="currentColor" fill-opacity="0.40" />
    <line x1="32" y1="58" x2="88" y2="58" stroke="currentColor" stroke-opacity="0.20" stroke-width="1" />
    <line x1="32" y1="70" x2="88" y2="70" stroke="currentColor" stroke-opacity="0.20" stroke-width="1" />
    <line x1="60" y1="50" x2="60" y2="80" stroke="currentColor" stroke-opacity="0.20" stroke-width="1" />

  {:else if variant === 'cloud'}
    <circle cx="48" cy="58" r="14" fill="currentColor" fill-opacity="0.35" />
    <circle cx="68" cy="54" r="18" fill="currentColor" fill-opacity="0.25" />
    <circle cx="58" cy="72" r="12" fill="currentColor" fill-opacity="0.30" />
    <circle cx="78" cy="68" r="8" fill="currentColor" fill-opacity="0.20" />

  {:else if variant === 'target'}
    <circle cx="60" cy="60" r="24" stroke="currentColor" stroke-opacity="0.30" stroke-width="2" fill="none" />
    <circle cx="60" cy="60" r="14" stroke="currentColor" stroke-opacity="0.45" stroke-width="2" fill="none" />
    <circle cx="60" cy="60" r="5"  fill="currentColor" fill-opacity="0.60" />

  {:else if variant === 'spark'}
    <rect x="32" y="68" width="8" height="20" rx="2" fill="currentColor" fill-opacity="0.30" />
    <rect x="46" y="56" width="8" height="32" rx="2" fill="currentColor" fill-opacity="0.40" />
    <rect x="60" y="42" width="8" height="46" rx="2" fill="currentColor" fill-opacity="0.55" />
    <rect x="74" y="50" width="8" height="38" rx="2" fill="currentColor" fill-opacity="0.40" />
    <path d="M36 68 L50 56 L64 42 L78 50" stroke="currentColor" stroke-opacity="0.60" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
  {/if}
</svg>
