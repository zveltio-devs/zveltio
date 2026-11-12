<script lang="ts">
/**
 * `stat`: a number. `count` is the data API's total for the filter; an action
 * source the caller may run is run once per input and its number shown. `sum`, `avg`, `min` and `max` have no
 * data API route yet: the stat says so rather than adding up one page of rows.
 */
import { resolveInput, type StatView, type Tone, type ViewScope } from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import {
  findAction,
  listParams,
  listRecords,
  runAction,
  runnableActions,
  type ViewHost,
} from './engine.js';

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

let seq = 0;
function settle(p: Promise<unknown>) {
  const mine = ++seq;
  p.then((v) => {
    if (mine !== seq) return;
    value = typeof v === 'number' ? v : Number(v);
    error = null;
  }).catch((e: Error) => {
    if (mine === seq) error = e.message || m['ext.loadFailed']();
  });
}

// A count is a read: it follows the data, so it reads again after an action ran.
$effect(() => {
  const src = view.source;
  if (unsupported || !('collection' in src)) return;
  void host.version;
  const q = listParams({ filter: src.filter }, scope, { page: 1, limit: 1 });
  if (q)
    settle(listRecords(src.collection, q).then((r) => r.pagination?.total ?? r.records.length));
});

/**
 * An action source (ADR 0042 decision 4: a computed number is an action; the
 * spike's `stat` primitive names `{ action }`) runs once per input, and only if
 * `GET /api/actions` lists it for the caller. Not on `host.version`: running an
 * action because another one ran is a side effect nobody asked for.
 */
const actionInput = $derived(
  'action' in view.source ? JSON.stringify(resolveInput(view.source.input, scope)) : null,
);
$effect(() => {
  const src = view.source;
  const key = actionInput;
  if (!('action' in src) || key === null || key === 'null') return;
  const input = JSON.parse(key) as Record<string, unknown>;
  settle(
    runnableActions().then((list) =>
      findAction(list, host.ext, src.action) ? runAction(host.ext, src.action, input) : Number.NaN,
    ),
  );
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
