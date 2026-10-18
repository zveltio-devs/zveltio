/**
 * One request as the god of a running engine, stepped up when the route needs
 * it (lib/step-up.ts): extension install/enable/configure need a fresh passkey
 * or TOTP proof, which `curl` cannot give.
 *
 *   bun scripts/god-request.ts <cookie-jar> <METHOD> <path> [json-body]
 *
 * The session is the one in curl's cookie jar, so the step-up token is bound to
 * the same session the rest of the script uses. The soft passkey is enrolled
 * with GOD_PASSWORD on the first call and kept in PROBE_PASSKEY_FILE for the
 * next ones (a second factor would itself need a step-up). Prints the response
 * body; exits 1 on a non-2xx answer.
 */
import { readFileSync } from 'node:fs';
import { steppedUpFetch } from '../packages/engine/src/testing/step-up.ts';

const [jar, method, path, body] = process.argv.slice(2);
if (!jar || !method || !path) {
  console.error('usage: bun scripts/god-request.ts <cookie-jar> <METHOD> <path> [json-body]');
  process.exit(2);
}
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const password = process.env.GOD_PASSWORD;
const keyFile = process.env.PROBE_PASSKEY_FILE;
if (!password || !keyFile) {
  console.error('GOD_PASSWORD and PROBE_PASSKEY_FILE are required');
  process.exit(2);
}

// Netscape cookie-jar lines: domain, flag, path, secure, expiry, name, value.
// curl writes HttpOnly cookies with a `#HttpOnly_` prefix on the domain.
const cookie = readFileSync(jar, 'utf8')
  .split('\n')
  .filter((l) => l.trim() && (!l.startsWith('#') || l.startsWith('#HttpOnly_')))
  .map((l) => l.split('\t'))
  .filter((f) => f.length >= 7)
  .map((f) => `${f[5]}=${f[6]}`)
  .join('; ');

const godFetch = await steppedUpFetch(
  BASE,
  cookie,
  password,
  process.env.BETTER_AUTH_URL ?? BASE,
  keyFile,
);
const res = await godFetch(path, {
  method,
  headers: { cookie, 'Content-Type': 'application/json' },
  body: body ?? (method === 'GET' ? undefined : '{}'),
});
process.stdout.write(await res.text());
process.exit(res.ok ? 0 : 1);
