/**
 * The integration lane. Same jsdom, same Svelte compiler, same aliases as the
 * unit lane — only the mock is gone: pages mount against a live engine, so a
 * route whose response shape moved breaks the page test that reads it.
 *
 * Needs an engine and a database:
 *
 *   bun run test:integration:boot       # one shell: fresh DB, migrate, god user, engine on :3399
 *   bun run test:integration            # another
 *
 * Sequential and unretried on purpose: the lane shares one engine and one
 * database, and a session invalidated in one file while another is mid-request
 * is a debugging cost nobody asked for.
 */

import base from './vitest.config.js';

// NOT `mergeConfig`: it CONCATENATES arrays, so `include` and `setupFiles`
// would come out as the union of both lanes — the first run of this file
// executed all 45 unit files against the live engine and reported them as
// integration coverage.
export default {
  ...base,
  test: {
    ...base.test,
    setupFiles: ['./tests/integration/setup.ts'],
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '.svelte-kit/**'],
    fileParallelism: false,
    retry: 0,
    // A real engine answering a real query is slower than an object literal.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
};
