<script lang="ts">
/**
 * Filters on a collection's fields (`@zveltio/ui`, ADR 0007 item 2): the active
 * ones as chips with a link that drops each, and a GET form that adds one as
 * `?field[op]=value` beside what `keep` carries. Adding or dropping a filter
 * goes back to the first page. The kit has no catalogue: the host passes the words.
 */
import { X } from '@lucide/svelte';
import type { CollectionField } from './collection.js';
import {
  type CollectionFilter,
  type FilterLabels,
  type FilterOp,
  filterOps,
  filterParam,
  inputKind,
  needsValue,
} from './fields.js';

let {
  fields,
  filters,
  action,
  keep = [],
  labels,
}: {
  fields: CollectionField[];
  filters: CollectionFilter[];
  /** The URL the form submits to and the drop links point at. */
  action: string;
  /** Parameters every link and the form carry (search, sort). */
  keep?: Array<[string, string]>;
  labels: FilterLabels;
} = $props();

const usable = $derived(fields.filter((f) => filterOps(f).length > 0));
let fieldName = $state<string>();
let op = $state<FilterOp>('contains');
const field = $derived(usable.find((f) => f.name === fieldName) ?? usable[0]);
const ops = $derived(field ? filterOps(field) : []);
// The chosen operator, or the field's first when it takes no such operator.
const chosen = $derived(ops.includes(op) ? op : ops[0]);
const kind = $derived(field ? inputKind(field.type) : 'text');

const label = (name: string) => {
  const f = fields.find((x) => x.name === name);
  return f?.label ?? name;
};
const without = (i: number) => {
  const qs = new URLSearchParams(keep);
  filters.forEach((f, j) => {
    if (j !== i) qs.append(filterParam(f), f.value);
  });
  return `${action}?${qs}`;
};
</script>

{#if usable.length > 0}
  <div class="flex flex-wrap items-center gap-2">
    {#each filters as f, i (filterParam(f) + i)}
      {@const text = `${label(f.field)} ${labels.ops[f.op]}${needsValue(f.op) ? ` ${f.value}` : ''}`}
      <span class="badge badge-outline gap-1">
        {text}
        <a href={without(i)} aria-label="{labels.remove}: {text}" class="inline-flex"><X size={12} /></a>
      </span>
    {/each}

    <form method="GET" {action} class="join">
      {#each keep as [k, v], i (k + i)}
        <input type="hidden" name={k} value={v} />
      {/each}
      {#each filters as f, i (filterParam(f) + i)}
        <input type="hidden" name={filterParam(f)} value={f.value} />
      {/each}
      <select bind:value={fieldName} aria-label={labels.field} class="select select-sm join-item">
        {#each usable as f (f.name)}
          <option value={f.name}>{f.label ?? f.name}</option>
        {/each}
      </select>
      <select
        value={chosen}
        onchange={(e) => (op = e.currentTarget.value as FilterOp)}
        aria-label={labels.op}
        class="select select-sm join-item"
      >
        {#each ops as o (o)}
          <option value={o}>{labels.ops[o]}</option>
        {/each}
      </select>
      {#if field && chosen && !needsValue(chosen)}
        <input type="hidden" name="{field.name}[{chosen}]" value="" />
      {:else if field && kind === 'checkbox'}
        <select name="{field.name}[{chosen}]" aria-label={labels.value} class="select select-sm join-item">
          <option value="true">{labels.yes}</option>
          <option value="false">{labels.no}</option>
        </select>
      {:else if field}
        <input
          name="{field.name}[{chosen}]"
          type={['number', 'date', 'datetime-local', 'time'].includes(kind) ? kind : 'text'}
          step={kind === 'number' ? 'any' : undefined}
          required
          aria-label={labels.value}
          class="input input-sm join-item"
        />
      {/if}
      <button class="btn btn-sm join-item">{labels.add}</button>
    </form>
  </div>
{/if}
