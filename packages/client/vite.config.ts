import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  /**
   * Vite only inlines `import.meta.env.X` for names matching a prefix, and the
   * default is `VITE_`. Ten modules read `import.meta.env.PUBLIC_ENGINE_URL`
   * and `.env.example` documents it, but without this the name was never
   * substituted: every one of them fell through to `window.location.origin`,
   * and setting the variable did nothing at all.
   *
   * The fallback is right for the normal install — the engine serves this app,
   * so its origin IS the engine. The variable matters when the two are split:
   * the client on a CDN or its own domain, the engine elsewhere.
   *
   * `PUBLIC_` is also SvelteKit's own prefix for browser-visible variables, so
   * this makes `import.meta.env` agree with `$env/static/public` rather than
   * introducing a second convention.
   */
  envPrefix: ['VITE_', 'PUBLIC_'],
});
