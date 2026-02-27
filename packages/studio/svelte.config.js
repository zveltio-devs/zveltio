import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html', // SPA mode — client-side routing
    }),
    paths: {
      base: '/admin', // Served at /admin from engine
    },
  },
};
