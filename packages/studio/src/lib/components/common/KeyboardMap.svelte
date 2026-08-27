<script lang="ts">
/**
 * What the keyboard can do, on `?`.
 *
 * The Studio has shortcuts and no way to learn them. ⌘K now has a visible field
 * in the top bar, which is the one that mattered most, but the rest — Escape,
 * the arrow keys inside the palette, Enter — were discoverable only by trying.
 *
 * `?` is the convention because it needs no modifier and cannot collide with
 * typing: the handler ignores the key whenever focus is in a field, which is
 * where a literal question mark is actually wanted.
 */
import { m } from '$lib/i18n.svelte.js';

let { open, onclose }: { open: boolean; onclose: () => void } = $props();

const GROUPS = $derived([
  {
    title: m['keys.group.global'](),
    rows: [
      { keys: ['⌘', 'K'], label: m['keys.openPalette']() },
      { keys: ['?'], label: m['keys.openThisSheet']() },
      { keys: ['Esc'], label: m['keys.closeOverlay']() },
    ],
  },
  {
    title: m['keys.group.palette'](),
    rows: [
      { keys: ['↑', '↓'], label: m['keys.moveSelection']() },
      { keys: ['↵'], label: m['keys.runSelection']() },
    ],
  },
  {
    title: m['keys.group.forms'](),
    rows: [{ keys: ['↵'], label: m['keys.submitForm']() }],
  },
]);
</script>

{#if open}
  <dialog open class="modal modal-open" role="dialog" aria-modal="true" aria-label={m['keys.title']()}>
    <div class="modal-box max-w-lg">
      <h3 class="text-lg font-bold">{m['keys.title']()}</h3>
      <div class="mt-4 flex flex-col gap-5">
        {#each GROUPS as g (g.title)}
          <div>
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-[.1em] text-base-content/65">
              {g.title}
            </p>
            <ul class="flex flex-col gap-1.5">
              {#each g.rows as r (r.label)}
                <li class="flex items-baseline justify-between gap-4 text-sm">
                  <span class="text-base-content/80">{r.label}</span>
                  <span class="flex shrink-0 gap-1">
                    {#each r.keys as k (k)}<kbd class="kbd kbd-sm">{k}</kbd>{/each}
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-sm" onclick={onclose}>{m['common.close']()}</button>
      </div>
    </div>
    <button type="button" class="modal-backdrop" aria-label={m['common.close']()} onclick={onclose}
    ></button>
  </dialog>
{/if}
