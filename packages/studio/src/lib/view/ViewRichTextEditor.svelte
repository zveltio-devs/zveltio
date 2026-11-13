<script lang="ts">
/**
 * Edits a `richtext` field. Its value may hold untrusted HTML (a reply quotes
 * the message it answers), so what enters the editable area is first made
 * inert by `safeUntrustedHtml`: the stored value, and anything pasted or
 * dropped. Remote images stay blocked while editing and are put back in the
 * value (`restoreBlocked`). Formatting is the browser's own editing commands.
 * ponytail: execCommand covers bold, italic and lists; a richer editor (links,
 * headings, tables) is a library such as TipTap, when a view needs it.
 */
import { m } from '#lib/i18n.svelte.js';
import { restoreBlocked, safeUntrustedHtml } from './untrusted-html.js';

interface Props {
  id: string;
  label: string;
  value: unknown;
  onchange: (html: string) => void;
}
const { id, label, value, onchange }: Props = $props();

let area = $state<HTMLDivElement>();
/** The value last written from here: an echo of it is not drawn again (the caret stays). */
let mine: unknown;

$effect(() => {
  const v = value;
  if (!area || v === mine) return;
  area.innerHTML = safeUntrustedHtml(v);
});

function emit() {
  if (!area) return;
  mine = restoreBlocked(area);
  onchange(mine as string);
}

function command(name: string) {
  area?.focus();
  document.execCommand(name);
  emit();
}

/** Pasted or dropped HTML goes in sanitised; the browser's own insert never sees it. */
function insert(e: ClipboardEvent | DragEvent) {
  const data = 'clipboardData' in e ? e.clipboardData : e.dataTransfer;
  if (!data) return;
  e.preventDefault();
  const html = data.getData('text/html');
  if (html) document.execCommand('insertHTML', false, safeUntrustedHtml(html));
  else document.execCommand('insertText', false, data.getData('text/plain'));
  emit();
}

const TOOLS = [
  ['bold', 'view.editor.bold', 'B'],
  ['italic', 'view.editor.italic', 'I'],
  ['insertUnorderedList', 'view.editor.bulletList', '•'],
  ['insertOrderedList', 'view.editor.numberedList', '1.'],
] as const;
</script>

<div class="border border-base-300 rounded-box">
  <div class="flex gap-1 border-b border-base-300 p-1" role="toolbar" aria-label={label}>
    {#each TOOLS as [cmd, key, glyph] (cmd)}
      <button
        type="button"
        class="btn btn-ghost btn-xs"
        aria-label={m[key]()}
        title={m[key]()}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => command(cmd)}>{glyph}</button
      >
    {/each}
  </div>
  <div
    bind:this={area}
    {id}
    class="min-h-40 p-3 text-sm focus:outline-none [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6"
    contenteditable="true"
    role="textbox"
    aria-multiline="true"
    aria-label={label}
    tabindex="0"
    oninput={emit}
    onpaste={insert}
    ondrop={insert}
    data-testid="view-richtext-editor"
  ></div>
</div>
