<!--
  Host scaffold for untrusted marketplace UI (C4).

  Feature-flagged and not wired into install/enable yet. Trusted first-party
  extensions still use compile-time `contribute.ts` slots. Marketplace /
  unsigned UI must not execute Svelte in the admin origin — this iframe +
  postMessage bridge is the intended escape hatch.

  Enable in a host with:
    <MarketplaceSandbox src={bundleUrl} extensionId={name} enabled={flag} />

  Protocol (v1):
    host → iframe:  { type: 'zveltio:marketplace:init', extensionId, locale }
    iframe → host:  { type: 'zveltio:marketplace:ready' }
    iframe → host:  { type: 'zveltio:marketplace:navigate', path }
    iframe → host:  { type: 'zveltio:marketplace:toast', level, message }
    host rejects any other message type / unexpected origin.
-->
<script lang="ts">
import { onMount } from 'svelte';

interface Props {
  /** Absolute URL of the sandboxed bundle (null = do not mount iframe). */
  src: string | null;
  extensionId: string;
  /** Opt-in — keep false until marketplace product wiring lands. */
  enabled?: boolean;
  locale?: string;
  title?: string;
  class?: string;
  onNavigate?: (path: string) => void;
  onToast?: (level: string, message: string) => void;
}

let {
  src,
  extensionId,
  enabled = false,
  locale = 'en',
  title = 'Extension',
  class: className = '',
  onNavigate,
  onToast,
}: Props = $props();

let frame = $state<HTMLIFrameElement | null>(null);
let ready = $state(false);
let lastError = $state<string | null>(null);

const ALLOWED_FROM_IFRAME = new Set([
  'zveltio:marketplace:ready',
  'zveltio:marketplace:navigate',
  'zveltio:marketplace:toast',
]);

function expectedOrigin(bundleSrc: string): string | null {
  try {
    return new URL(bundleSrc, window.location.href).origin;
  } catch {
    return null;
  }
}

function onMessage(event: MessageEvent): void {
  if (!src || !enabled) return;
  const origin = expectedOrigin(src);
  if (!origin || event.origin !== origin) return;
  if (frame?.contentWindow && event.source !== frame.contentWindow) return;

  const data = event.data;
  if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') {
    return;
  }
  const type = (data as { type: string }).type;
  if (!ALLOWED_FROM_IFRAME.has(type)) {
    lastError = `ignored message type: ${type}`;
    return;
  }

  if (type === 'zveltio:marketplace:ready') {
    ready = true;
    return;
  }
  if (type === 'zveltio:marketplace:navigate') {
    const path = (data as { path?: unknown }).path;
    if (typeof path === 'string' && path.startsWith('/')) onNavigate?.(path);
    return;
  }
  if (type === 'zveltio:marketplace:toast') {
    const level = String((data as { level?: unknown }).level ?? 'info');
    const message = String((data as { message?: unknown }).message ?? '');
    if (message) onToast?.(level, message);
  }
}

function postInit(): void {
  if (!frame?.contentWindow || !src) return;
  const origin = expectedOrigin(src);
  if (!origin) return;
  frame.contentWindow.postMessage(
    { type: 'zveltio:marketplace:init', extensionId, locale },
    origin,
  );
}

onMount(() => {
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
});
</script>

{#if enabled && src}
  <div
    class="marketplace-sandbox {className}"
    data-testid="marketplace-sandbox"
    data-extension-id={extensionId}
    data-ready={ready ? '1' : '0'}
  >
    <iframe
      bind:this={frame}
      {title}
      src={src}
      class="w-full min-h-[24rem] border border-base-300 rounded-lg bg-base-100"
      sandbox="allow-scripts allow-forms allow-popups"
      referrerpolicy="no-referrer"
      onload={postInit}
    ></iframe>
    {#if lastError}
      <p class="text-xs text-warning mt-1">{lastError}</p>
    {/if}
  </div>
{/if}
