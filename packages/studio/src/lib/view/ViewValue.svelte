<script lang="ts">
/**
 * One value as a view shows it. A `richtext` value is untrusted (ADR 0042
 * decision 10): in a `block` (a record's own fields) it is drawn inert in a
 * sandboxed frame (`ViewRichText`), elsewhere it is its text. A `file` value is
 * its files' names, each opening the file as the user.
 */
import type { Field, Tone } from '@zveltio/sdk/view';
import { fmtCell } from '#lib/components/collections/field-helpers.js';
import { elapsed } from './engine.js';
import ViewFiles from './ViewFiles.svelte';
import ViewRichText from './ViewRichText.svelte';
import { htmlText } from './untrusted-html.js';

interface Props {
  value: unknown;
  hint: Exclude<Field, string> | null;
  type?: string;
  /** A record's own field, with room to draw it whole (a detail), not a cell. */
  block?: boolean;
}
const { value, hint, type, block = false }: Props = $props();

const TONE: Record<Tone, string> = {
  neutral: 'badge-neutral',
  info: 'badge-info',
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-error',
  muted: 'badge-ghost',
};
// Own keys only: a value `constructor` or `toString` is not a tone.
const tone = $derived(
  hint?.tones && Object.hasOwn(hint.tones, String(value)) ? hint.tones[String(value)] : undefined,
);
</script>

{#if value === null || value === undefined}
  <span class="text-base-content/40">—</span>
{:else if type === 'richtext'}
  {#if block}<ViewRichText html={value} />{:else}{htmlText(value)}{/if}
{:else if type === 'file'}
  <ViewFiles {value} />
{:else if block && type === 'textarea'}
  <span class="whitespace-pre-wrap">{String(value)}</span>
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
