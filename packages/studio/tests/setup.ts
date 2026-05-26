/**
 * Vitest setup — runs before every test file.
 *
 *   - Adds @testing-library/jest-dom matchers (`toBeInTheDocument`,
 *     `toHaveTextContent`, etc.) onto `expect`.
 *   - Stubs DOM APIs jsdom doesn't ship (ResizeObserver, matchMedia)
 *     so components that lazy-touch them don't throw during render.
 */

import '@testing-library/jest-dom/vitest';

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
