<script lang="ts">
/**
 * One value as a view shows it. Text only: a `richtext` value is untrusted and
 * is never rendered as HTML here (ADR 0042 decision 10).
 */
import type { Field, Tone } from '@zveltio/sdk/view';
import { fmtCell } from '#lib/components/collections/field-helpers.js';
import { elapsed } from './engine.js';

interface Props {
  value: unknown;
  hint: Exclude<Field, string> | null;
  type?: string;
}
const { value, hint, type }: Props = $props();

const TONE: Record<Tone, string> = {
  neutral: 'badge-neutral',
  info: 'badge-info',
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-error',
  muted: 'badge-ghost',
};
const tone = $derived(hint?.tones?.[String(value)]);
</script>

{#if value === null || value === undefined}
  <span class="text-base-content/40">—</span>
{:else if hint?.display === 'badge' || tone}
  <span class={`badge badge-sm ${tone ? TONE[tone] : 'badge-ghost'}`}>{fmtCell(value, type)}</span>
{:else if hint?.display === 'flag' || typeof value === 'boolean'}
  <span>{value ? '✓' : '—'}</span>
{:else if hint?.display === 'mono'}
  <code class="font-mono text-xs">{fmtCell(value, type)}</code>
{:else if hint?.display === 'elapsed'}
  <span title={String(value)}>{elapsed(value)}</span>
{:else}
  {fmtCell(value, type)}
{/if}
