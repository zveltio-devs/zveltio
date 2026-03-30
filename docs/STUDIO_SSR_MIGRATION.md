# Studio SSR Migration Analysis

## Current State

Studio is built with SvelteKit + `@sveltejs/adapter-static` and deployed as a pure SPA (static HTML/JS/CSS). The engine serves the built assets from `/admin/*`.

Key files:
- `packages/studio/svelte.config.js` — `adapter-static` with `fallback: 'index.html'`
- `packages/studio/src/routes/+layout.ts` — `export const ssr = false`
- `packages/studio/src/routes/(admin)/+layout.ts` — `export const ssr = false`

## Why Migrate to SSR?

### 1. Content Security Policy (CSP) — Primary Driver

The current SPA model **requires `unsafe-inline`** in the CSP script-src directive because SvelteKit injects inline `<script>` tags to hydrate the app. This cannot be avoided with a static adapter.

With `adapter-node` (SSR), SvelteKit can generate a **nonce per request** and inject it into every inline script/style. The CSP header becomes:

```
script-src 'self' 'nonce-<random-per-request>'
style-src  'self' 'nonce-<random-per-request>'
```

This eliminates `unsafe-inline`, dramatically reducing XSS attack surface.

### 2. Streaming and Progressive Rendering

Large admin pages (Collections list, Audit Log) could stream their initial HTML shell while data loads, improving perceived performance.

### 3. Server-Side Data Loading

Currently all API calls happen client-side after JS loads. With SSR, `+page.server.ts` load functions run on the server and can populate the page on first render, eliminating loading spinners on initial navigation.

### 4. Better Search Engine Visibility (Low Priority for Admin)

Not a driver for the admin studio, but relevant if zones/portal pages are ever merged into the same SvelteKit app.

## Migration Cost Analysis

### What Changes

| Area | Current | After SSR |
|------|---------|-----------|
| Adapter | `adapter-static` | `adapter-node` |
| SSR flag | `ssr = false` everywhere | Remove `ssr = false` |
| Deployment | Static files served by Hono | Node.js server process |
| Build output | `packages/studio/build/` (static) | `packages/studio/build/` (Node server) |
| Engine serving | `Bun.file()` for static assets | Reverse proxy or separate port |

### What Must Be Fixed Before SSR

1. **`browser` guard all `onMount`-only code** — code reading `window`, `localStorage`, `document` must be guarded with `if (browser)` (from `$app/environment`).

2. **Fix server-only imports** — any import that uses Bun/Node APIs at module level will fail during SSR.

3. **Session hydration** — currently the SPA calls `/api/me` after load; with SSR this becomes a `+layout.server.ts` load that reads the session cookie server-side.

4. **`fetch` in load functions** — must use the SvelteKit-provided `fetch` parameter (not the global), which is already authenticated server-side.

5. **Remove `ssr = false` from all `+layout.ts` / `+page.ts`** — these are the main blockers.

### Estimated Effort

| Task | Effort |
|------|--------|
| Switch adapter, fix imports, remove ssr=false | ~1 day |
| Fix browser-only code guards | ~0.5 day |
| Server-side session in layout.server.ts | ~0.5 day |
| Update engine to proxy `/admin` to Node server | ~0.5 day |
| Test all pages for SSR regressions | ~1 day |
| Implement nonce-based CSP | ~0.5 day |
| **Total** | **~4 days** |

### Risks

- **SvelteKit stores are SSR-compatible but require care** — `writable()` stores must not share state between requests.
- **WebSocket connections** — the realtime SSE subscription is already client-only (`onMount`); no change needed.
- **`$app/paths` base** — already used correctly; no change needed.

## Recommended Approach

### Phase 1 — Incremental (Do Now, ~1 day)
Without SSR, add `trusted-types` CSP directive (see BLOC 5.2) to limit XSS surface even with `unsafe-inline`. This is the pragmatic short-term fix.

### Phase 2 — Full SSR Migration (Next Sprint, ~4 days)
1. Switch `svelte.config.js` to `adapter-node`
2. Remove all `ssr = false` declarations
3. Add `if (browser)` guards for browser APIs
4. Create `+layout.server.ts` for session hydration
5. Implement nonce-based CSP in the Node server's response headers
6. Update `packages/engine/src/index.ts` to reverse-proxy `/admin` to the Studio Node server

### Phase 3 — Enhanced (Optional)
- Streaming responses for large data tables
- Island architecture for interactive widgets

## Decision

**Proceed with Phase 2** in the next sprint. The 4-day estimate is acceptable given the CSP security improvement and the elimination of all client-side loading spinners.

Blocker: needs coordination with the deployment setup (currently Bun serves Studio static files directly). After migration, Studio runs as a separate Node.js process behind the engine.
