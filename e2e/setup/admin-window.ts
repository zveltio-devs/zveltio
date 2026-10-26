/**
 * Open the configuration window (engine lib/step-up.ts) for a session the
 * admin signed in with, browser or API context alike: every configuration
 * change needs one, and a journey that signs in through the login screen has
 * no passkey prompt to answer. A soft passkey stands in, enrolled once per
 * database (`E2E.adminPasskeyFile`).
 */
import { openConfigWindowOver } from '../../packages/engine/src/testing/step-up.js';
import { E2E } from './env.js';

export async function openAdminWindow(ctx: {
  storageState(): Promise<{ cookies: Array<{ name: string; value: string }> }>;
}): Promise<void> {
  const { cookies } = await ctx.storageState();
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  await openConfigWindowOver(
    E2E.baseURL,
    cookie,
    E2E.admin.password,
    E2E.baseURL,
    E2E.adminPasskeyFile,
  );
}
