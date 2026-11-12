<script lang="ts">
/**
 * `stat`: a number. `count` is the data API's total for the filter; an action
 * source is run and its number shown. `sum`, `avg`, `min` and `max` have no
 * data API route yet: the stat says so rather than adding up one page of rows.
 */
import { resolveInput, type StatView, type Tone, type ViewScope } from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import { listParams, listRecords, runAction, type ViewHost } from './engine.js';

interface Props {
  view: StatView;
  host: ViewHost;
  scope: ViewScope;
}
const { view, host, scope }: Props = $props();

let value = $state<number | null>(null);
let error = $state<string | null>(null);

const TONE: Record<Tone, string> = {
  neutral: '',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-error',
  muted: 'text-base-content/60',
};

const unsupported = $derived(
  'collection' in view.source && view.source.aggregate !== 'count' ? view.source.aggregate : null,
);

$effect(() => {
  void host.version;
  const src = view.source;
  if (unsupported) return;
  let p: Promise<unknown>;
  if ('collection' in src) {
    const q = listParams({ filter: src.filter }, scope, { page: 1, limit: 1 });
    if (!q) return;
    p = listRecords(src.collection, q).then((r) => r.pagination?.total ?? r.records.length);
  } else {
    const input = resolveInput(src.input, scope);
    if (!input) return;
    p = runAction(host.ext, src.action, input);
  }
  p.then((v) => {
    value = typeof v === 'number' ? v : Number(v);
    error = null;
  }).catch((e: Error) => (error = e.message || m['ext.loadFailed']()));
});

function show(v: number): string {
  if (view.format === 'money')
    return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (view.format === 'progress') return `${Math.round(v * 100)}%`;
  return v.toLocaleString();
}
</script>

<div class="stat bg-base-100 border border-base-200 rounded-box" data-testid="view-stat">
  {#if unsupported}
    <div class="stat-desc">{m['view.notDrawn']({ kind: unsupported })}</div>
  {:else if error}
    <div class="stat-desc text-error">{error}</div>
  {:else}
    <div class={`stat-value text-2xl ${view.tone ? TONE[view.tone] : ''}`}>
      {value === null || Number.isNaN(value) ? '—' : show(value)}
    </div>
  {/if}
</div>
