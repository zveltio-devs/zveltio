<script lang="ts">
/**
 * An untrusted `richtext` value, drawn (ADR 0042 decision 10): sanitised, in a
 * `srcdoc` frame with no `allow-scripts` and a `default-src 'none'` policy, so
 * nothing in it runs and nothing remote loads (`untrusted-html.ts`).
 */
import { m } from '#lib/i18n.svelte.js';
import { FRAME_SANDBOX, untrustedDocument } from './untrusted-html.js';

const { html }: { html: unknown } = $props();

let wrap = $state<HTMLDivElement>();
let frame = $state<HTMLIFrameElement>();
const color = $derived(wrap ? getComputedStyle(wrap).color : undefined);
const doc = $derived(untrustedDocument(html, color));

/** The frame as tall as its content: same origin, no script, so the parent measures it. */
function fit() {
  const h = frame?.contentDocument?.documentElement?.scrollHeight;
  if (frame && h) frame.style.height = `${h + 2}px`;
}
</script>

<div bind:this={wrap} class="w-full">
  <iframe
    bind:this={frame}
    title={m['view.richText']()}
    sandbox={FRAME_SANDBOX}
    referrerpolicy="no-referrer"
    srcdoc={doc}
    onload={fit}
    class="w-full min-h-16 border-0 bg-transparent"
    data-testid="view-richtext"
  ></iframe>
</div>
