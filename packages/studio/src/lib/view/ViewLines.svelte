<script lang="ts">
/**
 * The lines of an action form: an input property that is a list of objects,
 * drawn as a table with one column per scalar property of a line. A number is
 * kept as a number, an empty cell says nothing (the action's default applies).
 */
import { m } from '#lib/i18n.svelte.js';
import type { InputLines } from './engine.js';

interface Props {
  lines: InputLines;
  label: string;
  rows: Record<string, unknown>[];
  onchange: (rows: Record<string, unknown>[]) => void;
}
const { lines, label, rows, onchange }: Props = $props();

const choices = (c: InputLines['columns'][number]) =>
  ((c.options as { choices?: unknown[] } | undefined)?.choices ?? []).map(String);

let addButton = $state<HTMLButtonElement>();

/** An empty cell, or an unticked box, says nothing: the line stays empty. */
function set(i: number, name: string, raw: unknown) {
  const next = rows.map((r) => ({ ...r }));
  if (raw === '' || raw === undefined || raw === false) delete next[i][name];
  else next[i][name] = raw;
  onchange(next);
}
function num(i: number, name: string, text: string) {
  const n = Number(text);
  const v = lines.integers.includes(name) ? Math.trunc(n) : n;
  set(i, name, text === '' || Number.isNaN(n) ? undefined : v);
}
function remove(i: number) {
  onchange(rows.filter((_, j) => j !== i));
  // The focused button is gone with its row: keep the keyboard in the table.
  addButton?.focus();
}
</script>

<fieldset class="space-y-2" data-testid={`view-lines-${lines.name}`}>
  <legend class="label-text font-semibold">
    {label}
    {#if lines.min > 0}<span class="text-error">*</span>{/if}
  </legend>
  <div class="overflow-x-auto">
    <table class="table table-sm">
      <thead>
        <tr>
          {#each lines.columns as c (c.name)}
            <th>{c.label ?? c.name}{#if c.required}<span class="text-error">*</span>{/if}</th>
          {/each}
          <th><span class="sr-only">{m['common.remove']()}</span></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row, i (i)}
          <tr>
            {#each lines.columns as c (c.name)}
              {@const aria = `${c.label ?? c.name} ${i + 1}`}
              <td>
                {#if c.type === 'boolean'}
                  <input
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    aria-label={aria}
                    checked={row[c.name] === true}
                    onchange={(e) => set(i, c.name, e.currentTarget.checked)}
                  />
                {:else if c.type === 'select'}
                  <select
                    class="select select-bordered select-sm"
                    aria-label={aria}
                    value={row[c.name] ?? ''}
                    onchange={(e) => set(i, c.name, e.currentTarget.value)}
                  >
                    <option value=""></option>
                    {#each choices(c).filter((v) => v !== '') as v (v)}<option value={v}>{v}</option>{/each}
                  </select>
                {:else}
                  <input
                    type={c.type === 'number' ? 'number' : 'text'}
                    step={lines.integers.includes(c.name) ? 1 : 'any'}
                    required={c.required === true}
                    aria-required={c.required === true}
                    class="input input-bordered input-sm w-full min-w-24"
                    aria-label={aria}
                    value={row[c.name] ?? ''}
                    oninput={(e) =>
                      c.type === 'number'
                        ? num(i, c.name, e.currentTarget.value)
                        : set(i, c.name, e.currentTarget.value)}
                  />
                {/if}
              </td>
            {/each}
            <td>
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                aria-label={`${m['common.remove']()} ${i + 1}`}
                disabled={rows.length <= lines.min}
                onclick={() => remove(i)}>✕</button
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <button
    type="button"
    class="btn btn-ghost btn-sm"
    bind:this={addButton}
    onclick={() => onchange([...rows, {}])}
  >
    + {m['common.add']()}
  </button>
</fieldset>
