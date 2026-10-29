/**
 * zveltio login [--url <engine-url>] [--email <email>]
 * zveltio logout [--url <engine-url>]
 *
 * Sign the CLI in to an engine as its user (ADR 0011). The password and the
 * authenticator code are asked for, never taken as flags.
 */
import { createInterface } from 'readline';
import {
  credentialsPath,
  engineFetch,
  forgetSession,
  saveSession,
  sessionFor,
  signIn,
} from '../lib/engine-session.js';
import { prompt, promptHidden } from '../lib/prompt.js';

const engineUrlOf = (url?: string) => url || process.env.ENGINE_URL || 'http://localhost:3000';

export async function loginCommand(opts: { url?: string; email?: string }) {
  const url = engineUrlOf(opts.url);
  let email = opts.email;
  if (!email) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    email = await prompt(rl, 'Email: ');
    rl.close();
  }
  const password = await promptHidden('Password: ');
  try {
    // A second login replaces the session: end the old one rather than orphan it.
    if (sessionFor(url)) await endOnEngine(url);
    const token = await signIn(url, email.trim(), password, () =>
      promptHidden('Authenticator code: '),
    );
    saveSession(url, token);
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }
  console.log(`✅ Signed in to ${new URL(url).origin} (session kept in ${credentialsPath()}).`);
}

export async function logoutCommand(opts: { url?: string }) {
  const url = engineUrlOf(opts.url);
  let ended: boolean;
  try {
    if (!sessionFor(url)) {
      console.log(`Not signed in to ${new URL(url).origin}.`);
      return;
    }
    ended = await endOnEngine(url);
    forgetSession(url);
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }
  if (!ended) {
    console.error(
      `⚠️  Forgot the local session, but ${new URL(url).origin} did not confirm the sign-out. ` +
        'It may still be valid: revoke it in the Console under your sessions.',
    );
    process.exit(1);
  }
  console.log(`Signed out of ${new URL(url).origin}.`);
}

/** Sign the stored session out on the engine; false when the engine did not confirm. */
async function endOnEngine(url: string): Promise<boolean> {
  const res = await engineFetch({ url }, '/api/auth/sign-out', {
    method: 'POST',
    headers: { Origin: new URL(url).origin },
  }).catch(() => null);
  return res?.ok === true;
}
