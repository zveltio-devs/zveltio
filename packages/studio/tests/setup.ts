/**
 * Vitest setup — runs before every test file.
 *
 *   - Adds @testing-library/jest-dom matchers (`toBeInTheDocument`,
 *     `toHaveTextContent`, etc.) onto `expect`.
 *   - Stubs DOM APIs jsdom doesn't ship (ResizeObserver, matchMedia)
 *     so components that lazy-touch them don't throw during render.
 */

import '@testing-library/jest-dom/vitest';

// Polyfill Element.animate — jsdom does not implement the Web Animations API,
// and Svelte's outro transitions call it while a component unmounts. The
// rejection surfaces after the test that triggered it has already passed, so it
// shows up as a file-level error with a misleading "latest test" attached.
if (!Element.prototype.animate) {
  Element.prototype.animate = (): Animation => {
    const anim = {
      cancel() {},
      finish() {},
      onfinish: null as (() => void) | null,
      currentTime: 0,
      startTime: 0,
      playState: 'finished',
    };
    // Svelte removes an outroing element from `onfinish`. Without this call the
    // node lingers for the whole test and a closed dialog still matches
    // `[role="dialog"]`.
    queueMicrotask(() => anim.onfinish?.());
    return anim as unknown as Animation;
  };
}

// Polyfill ResizeObserver — Studio sidebar uses it for collapse animation.
class _ResizeObserver {
  observe() {
    /* noop */
  }
  unobserve() {
    /* noop */
  }
  disconnect() {
    /* noop */
  }
}
(globalThis as any).ResizeObserver = _ResizeObserver;

// Polyfill matchMedia — DaisyUI theme detection reads this on first paint.
if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {
      /* noop */
    },
    removeListener: () => {
      /* noop */
    },
    addEventListener: () => {
      /* noop */
    },
    removeEventListener: () => {
      /* noop */
    },
    dispatchEvent: () => false,
  })) as any;
}
