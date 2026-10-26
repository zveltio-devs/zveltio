import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({
        pages: 'dist',
        assets: 'dist',
        fallback: 'index.html' /* SPA mode — client-side routing */,
      }),
      paths: { base: '/admin' },
      onwarn: (warning, handler) => {
        if (warning.code.startsWith('a11y')) return;

        handler(warning);
      },
    }),
    tailwindcss(),
  ],
  // Same reason as the client's: `PUBLIC_ENGINE_URL` is read here too (the
  // storage upload widget), and without the prefix Vite never substitutes it.
  // See packages/client/vite.config.ts for the full note.
  envPrefix: ['VITE_', 'PUBLIC_'],
});
