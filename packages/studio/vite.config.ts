import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [sveltekit(), tailwindcss()],
  // Same reason as the client's: `PUBLIC_ENGINE_URL` is read here too (the
  // storage upload widget), and without the prefix Vite never substitutes it.
  // See packages/client/vite.config.ts for the full note.
  envPrefix: ['VITE_', 'PUBLIC_'],
});
