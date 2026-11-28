<script lang="ts">
/**
 * A relation drawn as a picker (a `m2o` or `reference` field of a collection
 * form, a `pick` input of an action): search the related collection's records
 * through the data API as the user, show their labels (as `recordLabels` does
 * for matrix axes), store the id. A value the caller cannot read stays its id.
 * `onchange('')` clears the value.
 */
import { labelFromRecord } from '#lib/components/collections/field-helpers.js';
import { m } from '#lib/i18n.svelte.js';
import { listRecords, recordLabels } from './engine.js';

interface Props {
  collection: string;
  value: unknown;
  id: string;
  onchange: (id: string) => void;
}
const { collection, value, id, onchange }: Props = $props();

let query = $state('');
let options = $state<{ id: string; label: string }[]>([]);
let open = $state(false);
/** The label of the chosen record; `null` while unknown or not readable. */
let current = $state<string | null>(null);

const chosen = $derived(
  value === null || value === undefined || value === '' ? null : String(value),
);

$effect(() => {
  const v = chosen;
  current = null;
  if (!v) return;
  recordLabels(collection, [v]).then(
    (found) => {
      if (chosen === v) current = found.get(v) ?? null;
    },
    () => {},
  );
});

let seq = 0;
// ponytail: one read per keystroke, the latest answer wins; debounce if lists get large.
function search(q: string) {
  query = q;
  open = true;
  const mine = ++seq;
  listRecords(collection, { page: 1, limit: 20, ...(q.trim() ? { search: q.trim() } : {}) }).then(
    (res) => {
      if (mine === seq)
        options = res.records.map((r) => ({ id: String(r.id), label: labelFromRecord(r) }));
    },
    () => {
      if (mine === seq) options = [];
    },
  );
}

function choose(picked: string) {
  onchange(picked);
  open = false;
  query = '';
}
</script>

<div class="relative space-y-1" data-testid="view-picker">
  {#if chosen}
    <div class="flex items-center gap-2 text-sm">
      <span data-testid="view-picker-current">{current ?? chosen}</span>
      <button type="button" class="btn btn-ghost btn-xs" onclick={() => choose('')}>
        {m['common.clear']()}
      </button>
    </div>
  {/if}
  <input
    {id}
    class="input input-bordered w-full"
    placeholder={m['common.search']()}
    autocomplete="off"
    value={query}
    onfocus={() => search(query)}
    oninput={(e) => search((e.currentTarget as HTMLInputElement).value)}
  />
  {#if open}
    <ul
      class="menu bg-base-100 border border-base-200 rounded-box w-full max-h-60 overflow-auto absolute z-10"
    >
      {#each options as o (o.id)}
        <li><button type="button" onclick={() => choose(o.id)}>{o.label}</button></li>
      {:else}
        <li class="disabled"><span>{m['common.noResults']()}</span></li>
      {/each}
    </ul>
  {/if}
</div>
