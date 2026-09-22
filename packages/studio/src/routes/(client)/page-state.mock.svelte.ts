/**
 * Reactive stand-in for `$app/state`, so a test can move the URL while the
 * layout stays mounted. Its own module because a `vi.mock` factory importing
 * the test file back never settles.
 */
export const pageState = $state({
  url: new URL('http://localhost/admin/portal-client/login'),
  params: {} as Record<string, string>,
  status: 200,
  error: null as { message: string } | null,
});
