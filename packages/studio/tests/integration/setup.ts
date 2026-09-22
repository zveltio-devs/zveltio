/**
 * Setup for the integration lane: the same pages the unit tests mount, but
 * talking to a REAL engine instead of a hand-written `$lib/api.js` mock.
 *
 * Why this lane exists. Every admin page test in `src/routes/(admin)/**`
 * replaces `$lib/api.js` with an object literal, so each one asserts against a
 * shape a human typed from memory. That catches page logic and nothing else:
 * when a route's response changes — a key renamed, an array moved under an
 * envelope, a 200 that became a 403 — the mock keeps answering the old shape
 * and the test stays green while the screen is blank in production. An external
 * audit lost its whole Studio pass to exactly that class of failure. The
 * browser suite sees it, but it is deliberately ten journeys, not 79 pages.
 *
 * What this file provides:
 *   - `zveltio.engineUrl` in `localStorage` BEFORE any test module imports
 *     `$lib/config.js`, which resolves `ENGINE_URL` once at module evaluation.
 *   - A cookie jar over `fetch`. `api` sends `credentials: 'include'`, which is
 *     a no-op outside a browser: undici neither stores nor replays the session
 *     cookie, so without this every admin route answers 401 at the door and the
 *     whole lane reads as an authorization regression.
 *   - A signed-in god session, obtained through `POST /api/auth/sign-in/email`
 *     the way the login screen does it.
 *
 * It fails loudly when the engine is missing. It must NOT skip: a suite that
 * reports green because it quietly did nothing is the failure mode this
 * repository has already paid for in its extension contract suite.
 */

import '../setup.js';

const BASE = process.env.STUDIO_IT_BASE_URL ?? 'http://127.0.0.1:3399';
const EMAIL = process.env.STUDIO_IT_EMAIL ?? 'e2e-admin@test.invalid';
const PASSWORD = process.env.STUDIO_IT_PASSWORD ?? 'E2ePassw0rd!';

// Before `$lib/config.js` is evaluated by any test module.
window.localStorage.setItem('zveltio.engineUrl', BASE);

/** name -> value. One session, one process, one test file. */
const jar = new Map<string, string>();

const nativeFetch = globalThis.fetch;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const headers = new Headers(init?.headers);
  if (jar.size > 0 && !headers.has('cookie')) {
    headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  }
  const res = await nativeFetch(input, { ...init, headers });
  // undici exposes the unmerged list; a plain `get('set-cookie')` folds several
  // cookies into one comma-joined string and loses the boundaries.
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // An expiry in the past is a deletion, and keeping it would replay a dead
    // session cookie as if it were live.
    if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
  return res;
};

async function reachable(): Promise<void> {
  try {
    const res = await nativeFetch(`${BASE}/health`);
    if (!res.ok) throw new Error(`GET /health answered ${res.status}`);
  } catch (err) {
    throw new Error(
      `No engine at ${BASE} (${(err as Error).message}). This lane drives the real API on purpose ` +
        'and will not skip itself. Start one with `bun run test:integration:boot` in another ' +
        'shell, or point STUDIO_IT_BASE_URL at a running engine.',
    );
  }
}

async function signIn(): Promise<void> {
  const res = await globalThis.fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(
      `sign-in as ${EMAIL} answered ${res.status}: ${await res.text()}. The boot script creates ` +
        'this account with `create-god`; a database reused from an earlier run may hold a ' +
        'different password.',
    );
  }
  if (jar.size === 0)
    throw new Error('sign-in succeeded but set no cookie — the jar would send nothing');
}

await reachable();
await signIn();
