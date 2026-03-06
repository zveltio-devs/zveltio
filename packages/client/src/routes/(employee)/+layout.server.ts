import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/**
 * Server-side auth guard — verifica sesiunea INAINTE de a randa pagina.
 * Zero flash of unauthenticated content.
 */
export const load: LayoutServerLoad = async ({ fetch, url }) => {
  const engineUrl = import.meta.env.PUBLIC_ENGINE_URL ?? process.env.PUBLIC_ENGINE_URL ?? 'http://localhost:3000';

  const res = await fetch(`${engineUrl}/api/auth/get-session`, {
    credentials: 'include',
  });

  if (!res.ok) {
    throw redirect(302, `/auth/login?returnTo=${encodeURIComponent(url.pathname)}`);
  }

  const session = await res.json();
  const user = session?.user;

  if (!user || !['employee', 'manager', 'admin', 'god'].includes(user.role)) {
    throw redirect(302, '/auth/login?error=insufficient_role');
  }

  return { user };
};
