import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
export default {
  onwarn: (warning, handler) => {
    if (warning.code.startsWith('a11y')) return;
    handler(warning);
  },
  kit: {
    adapter: adapter({
      pages: 'dist',
      assets: 'dist',
      fallback: 'index.html', // SPA mode — client-side routing
    }),
    paths: { base: '/admin' },
  },
};
