// Engine URL resolution.
//
// Priority:
//   1. Runtime override in localStorage (`zveltio.engineUrl`) — set by the
//      Capacitor mobile shell, which bundles this Studio and points it at the
//      user's self-hosted instance. (No effect for the embedded Studio, where
//      the key is never set.)
//   2. `VITE_ENGINE_URL` build-time env — dev against a remote engine.
//   3. `window.location.origin` — the embedded Studio served at <engine>/admin.
function resolveEngineUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    const saved = window.localStorage?.getItem('zveltio.engineUrl');
    if (saved) return saved.replace(/\/+$/, '');
  } catch {
    // localStorage may be unavailable (private mode) — fall through.
  }
  return (import.meta.env.VITE_ENGINE_URL as string) || window.location.origin;
}

export const ENGINE_URL: string = resolveEngineUrl();

// Inject engine URL for extensions
if (typeof window !== 'undefined') {
  (window as any).__ZVELTIO_ENGINE_URL__ = ENGINE_URL;
}
