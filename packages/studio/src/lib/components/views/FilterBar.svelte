<script lang="ts">
  import { Filter, X, Plus } from '@lucide/svelte';

  interface FilterRule {
    field: string;
    operator: string;
    value: any;
  }

  interface Props {
    fields?: any[];
    filters?: FilterRule[];
    onChange?: (filters: FilterRule[]) => void;
  }

  let { fields = [], filters = [], onChange }: Props = $props();

  const OPERATORS: Record<string, string[]> = {
    text:     ['contains', 'equals', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'],
    number:   ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_empty'],
    boolean:  ['is_true', 'is_false'],
    date:     ['equals', 'before', 'after', 'is_empty'],
    datetime: ['equals', 'before', 'after', 'is_empty'],
    select:   ['equals', 'not_equals', 'is_empty'],
    default:  ['equals', 'not_equals', 'is_empty', 'is_not_empty'],
  };

  function getOperators(fieldName: string): string[] {
    const f = fields.find((f: any) => f.name === fieldName);
    return OPERATORS[f?.type as string] ?? OPERATORS.default;
  }

  function addFilter() {
    const first = fields.find((f: any) => !f.is_system);
    if (!first) return;
    onChange?.([...filters, { field: first.name, operator: 'contains', value: '' }]);
  }

  function removeFilter(i: number) {
    onChange?.(filters.filter((_, idx) => idx !== i));
  }

  function updateFilter(i: number, key: keyof FilterRule, val: any) {
    onChange?.(filters.map((f, idx) => idx === i ? { ...f, [key]: val } : f));
  }

  const needsValue = (op: string) =>
    !['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(op);
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center gap-2">
    <Filter size={14} class="text-base-content/50"/>
    <span class="text-sm font-medium">Filters</span>
    <button class="btn btn-ghost btn-xs gap-1 ml-auto" onclick={addFilter}>
      <Plus size={12}/> Add filter
    </button>
  </div>

  {#if filters.length === 0}
    <p class="text-xs text-base-content/40 py-1">No filters applied</p>
  {:else}
    <div class="flex flex-col gap-1.5">
      {#each filters as rule, i}
        <div class="flex items-center gap-2 bg-base-200 rounded-lg px-2 py-1.5 flex-wrap">
          <select class="select select-xs select-bordered" value={rule.field}
            onchange={(e) => updateFilter(i, 'field', (e.target as HTMLSelectElement).value)}>
            {#each fields.filter((f: any) => !f.is_system) as f}
              <option value={f.name}>{f.display_name ?? f.name}</option>
            {/each}
          </select>

          <select class="select select-xs select-bordered" value={rule.operator}
            onchange={(e) => updateFilter(i, 'operator', (e.target as HTMLSelectElement).value)}>
            {#each getOperators(rule.field) as op}
              <option value={op}>{op.replace(/_/g, ' ')}</option>
            {/each}
          </select>

          {#if needsValue(rule.operator)}
            <input class="input input-xs input-bordered flex-1 min-w-32"
              type="text" value={rule.value ?? ''} placeholder="Value…"
              oninput={(e) => updateFilter(i, 'value', (e.target as HTMLInputElement).value)}/>
          {/if}

          <button class="btn btn-ghost btn-xs text-error" onclick={() => removeFilter(i)}>
            <X size={12}/>
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>