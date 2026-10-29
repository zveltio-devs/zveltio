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
  if (!sessionFor(url)) {
    console.log(`Not signed in to ${new URL(url).origin}.`);
    return;
  }
  // End it on the engine too; the local copy goes either way.
  await engineFetch({ url }, '/api/auth/sign-out', {
    method: 'POST',
    headers: { Origin: new URL(url).origin },
  }).catch(() => null);
  forgetSession(url);
  console.log(`Signed out of ${new URL(url).origin}.`);
}
