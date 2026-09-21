/**
 * A reactive stand-in for `$app/state`, for tests that need the route parameter
 * to CHANGE while the component stays mounted.
 *
 * It lives in its own module because a `vi.mock` factory that imports the test
 * file back is a cycle: the factory runs while that module is still
 * initialising, and the dynamic `import('./+page.svelte')` in the test never
 * settles — a timeout with no assertion failure and no output to explain it.
 */
export const pageState = $state({
  url: new URL('http://localhost/admin/collections/orders'),
  params: { name: 'orders' } as { name: string },
});
