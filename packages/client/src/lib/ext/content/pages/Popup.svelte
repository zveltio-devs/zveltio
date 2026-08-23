<script lang="ts">
  /**
   * A popup, drawn over the page it belongs to.
   *
   * It is a page: its blocks came through the same resolver with the same
   * audience, so a data block inside one is judged exactly as a data block on
   * the page behind it. That is the whole reason a popup is `kind = 'popup'` on
   * `zv_pages` rather than a builder of its own — a parallel implementation
   * would have been a second place to get authorisation wrong.
   *
   * Everything here is presentation: when it shows, how often, and how it
   * closes. The rules a visitor cannot argue with were settled on the server.
   */
  import { onMount, onDestroy } from 'svelte';
  import Self from './BlockRenderer.svelte';

  // biome-ignore lint/suspicious/noExplicitAny: popup payloads are untyped JSON
  type Any = any;

  let { popup, blocksBaseUrl = '' }: { popup: Any; blocksBaseUrl?: string } = $props();

  const cfg = $derived(popup?.config ?? {});
  const key = $derived(`zv-popup:${popup?.id}`);

  let open = $state(false);
  let dismissed = $state(false);
  const timers: ReturnType<typeof setTimeout>[] = [];

  /**
   * Has this visitor already dealt with it?
   *
   * `once` remembers across visits, `session` for this tab, `always` never
   * remembers. Storage can throw — private modes, blocked cookies — and a popup
   * that cannot read its own history should still behave, so a failure means
   * "not seen" rather than an exception on page load.
   */
  function alreadySeen(): boolean {
    const freq = cfg.frequency ?? 'session';
    if (freq === 'always') return false;
    try {
      const store = freq === 'once' ? localStorage : sessionStorage;
      return store.getItem(key) === '1';
    } catch {
      return false;
    }
  }

  function remember(): void {
    const freq = cfg.frequency ?? 'session';
    if (freq === 'always') return;
    try {
      const store = freq === 'once' ? localStorage : sessionStorage;
      store.setItem(key, '1');
    } catch {
      /* storage unavailable — it will simply show again */
    }
  }

  function show(): void {
    if (dismissed || alreadySeen()) return;
    open = true;
  }

  function close(): void {
    open = false;
    dismissed = true;
    remember();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) close();
  }

  function onMouseOut(e: MouseEvent) {
    // Exit intent: the pointer leaving through the top of the viewport.
    if (e.clientY <= 0 && !e.relatedTarget) show();
  }

  function onScroll() {
    const pct = cfg.scroll_percent ?? 50;
    const height = document.documentElement.scrollHeight - window.innerHeight;
    if (height <= 0) return show();
    if ((window.scrollY / height) * 100 >= pct) show();
  }

  onMount(() => {
    if (alreadySeen()) return;
    const trigger = cfg.trigger ?? 'delay';

    if (trigger === 'load') show();
    else if (trigger === 'delay') {
      timers.push(setTimeout(show, Math.min(Math.max(Number(cfg.delay_seconds) || 3, 0), 120) * 1000));
    } else if (trigger === 'scroll') {
      window.addEventListener('scroll', onScroll, { passive: true });
    } else if (trigger === 'exit') {
      document.addEventListener('mouseout', onMouseOut);
    } else if (trigger === 'click' && typeof cfg.selector === 'string' && cfg.selector) {
      // A selector the author typed. `querySelectorAll` throws on a malformed
      // one, and a mistyped selector must not take the page down with it.
      try {
        for (const el of document.querySelectorAll(cfg.selector)) {
          el.addEventListener('click', show);
        }
      } catch {
        /* invalid selector — the popup simply never opens */
      }
    }

    window.addEventListener('keydown', onKeydown);
  });

  onDestroy(() => {
    for (const t of timers) clearTimeout(t);
    if (typeof window === 'undefined') return;
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('keydown', onKeydown);
    document.removeEventListener('mouseout', onMouseOut);
  });

  const positionClass = $derived(
    cfg.position === 'top' ? 'items-start pt-10'
    : cfg.position === 'bottom' ? 'items-end pb-10'
    : 'items-center',
  );
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex justify-center overflow-y-auto {positionClass}"
    style:background={cfg.overlay === false ? 'transparent' : 'rgba(0,0,0,0.5)'}
    role="presentation"
    onclick={(e) => { if (e.target === e.currentTarget && cfg.overlay !== false) close(); }}
  >
    <div
      class="relative bg-base-100 rounded-xl shadow-2xl m-4 w-full"
      style:max-width={`${Math.min(Math.max(Number(cfg.width) || 560, 240), 1200)}px`}
      role="dialog"
      aria-modal="true"
      aria-label={popup?.title ?? 'Dialog'}
    >
      <button
        class="absolute right-2 top-2 z-10 rounded-full w-8 h-8 flex items-center justify-center
          text-xl leading-none opacity-60 hover:opacity-100 hover:bg-base-200"
        onclick={close}
        aria-label="Close"
      >×</button>

      <Self blocks={popup?.blocks ?? []} {blocksBaseUrl} nested gap="none" />
    </div>
  </div>
{/if}
