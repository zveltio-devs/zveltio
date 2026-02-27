// Engine URL — in dev mode use VITE_ENGINE_URL, in production it's the same origin
export const ENGINE_URL: string =
  typeof window !== 'undefined'
    ? (import.meta.env.VITE_ENGINE_URL as string) || window.location.origin
    : '';

// Inject engine URL for extensions
if (typeof window !== 'undefined') {
  (window as any).__ZVELTIO_ENGINE_URL__ = ENGINE_URL;
}
